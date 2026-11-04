/** watch + status + relay: lifecycle commands. */
import { Command } from 'commander'
import { ethers } from 'ethers'

import { getChain, loadConfig, provider, COMPOSER_ABI, ERC20_ABI } from '../../lib/common'
import { trackSwap, type StepEvent } from '../../lib/tracker'
import { c, emitJson, note, spinner } from '../ui'

const STEP_LABELS: Record<string, string> = {
    source_confirmed: 'source confirmed',
    bridging: 'bridging',
    attesting: 'attesting (Circle)',
    attested: 'attested',
    delivered: 'delivered',
    executed: 'swap executed',
    refunded: 'refunded',
    escrowed: 'refund escrowed',
    timeout: 'timed out',
}

export function registerTrack(program: Command): void {
    program
        .command('watch')
        .description('Follow a swap live through every step to its final outcome')
        .requiredOption('--from <chain>', 'source chain of the transaction')
        .requiredOption('--tx <hash>', 'source-chain transaction hash')
        .option('--json', 'emit newline-delimited JSON events instead of text', false)
        .action(async (opts) => {
            const render = (e: StepEvent) => {
                if (opts.json) {
                    console.log(JSON.stringify(e))
                    return
                }
                const t = new Date(e.at).toLocaleTimeString()
                const mark = e.state === 'done' ? c.green('✓') : e.state === 'failed' ? c.red('✗') : c.dim('…')
                console.log(`[${t}] ${mark} ${STEP_LABELS[e.step] ?? e.step} — ${e.detail}${e.txHash ? c.dim(` (${e.txHash})`) : ''}`)
            }
            await trackSwap(opts.from, opts.tx, render)
        })

    program
        .command('status')
        .description("One-shot answer to where's my money across the bridge explorers")
        .requiredOption('--from <chain>', 'source chain of the transaction')
        .requiredOption('--tx <hash>', 'source-chain transaction hash')
        .option('--json', 'print the status as one JSON object', false)
        .action(async (opts) => {
            const config = loadConfig()
            const srcChain = getChain(config, opts.from)

            try {
                const res = await fetch(`https://scan.layerzero-api.com/v1/messages/tx/${opts.tx}`)
                if (res.ok) {
                    const body = (await res.json()) as { data?: { status?: { name?: string }; pathway?: { dstEid?: number } }[] }
                    if ((body.data ?? []).length > 0) {
                        if (opts.json) {
                            emitJson({ rail: 'oft', messages: body.data!.map((m) => ({ status: m.status?.name ?? 'unknown', dstEid: m.pathway?.dstEid ?? null })) })
                            return
                        }
                        for (const m of body.data!) {
                            console.log(`bridge: ${c.bold(m.status?.name ?? 'unknown')} dstEid=${m.pathway?.dstEid ?? '?'}  ${c.dim('follow live with: invictae watch')}`)
                        }
                        return
                    }
                }
            } catch {
                // fall through to CCTP
            }
            if (srcChain.cctp) {
                const irisApi = config.cctp?.irisApi ?? 'https://iris-api.circle.com'
                const res = await fetch(`${irisApi}/v2/messages/${srcChain.cctp.domain}?transactionHash=${opts.tx}`)
                if (res.ok) {
                    const body = (await res.json()) as { messages?: { status: string }[] }
                    if ((body.messages ?? []).length > 0) {
                        if (opts.json) {
                            emitJson({ rail: 'cctp', messages: body.messages!.map((m) => ({ status: m.status })) })
                            return
                        }
                        for (const m of body.messages!) {
                            console.log(
                                `CCTP: attestation ${c.bold(m.status)}${m.status === 'complete' ? ' — run invictae relay to finish' : ' (waiting on Circle)'}`
                            )
                        }
                        return
                    }
                }
            }
            if (opts.json) emitJson({ rail: null, messages: [] })
            else note('No bridge message or CCTP burn found for that tx (yet) — wrong chain, or still indexing.')
        })

    program
        .command('relay')
        .description("Completes a CCTP swap: fetches Circle's attestation and submits relayAndSwap on the destination")
        .requiredOption('--from <chain>', 'source chain of the burn')
        .requiredOption('--to <chain>', 'destination chain (where the composer runs)')
        .requiredOption('--tx <hash>', 'source-chain burn transaction hash')
        .option('--fee <n>', 'relay fee to request in stable units (honored up to the order cap)', '0')
        .action(async (opts) => {
            const config = loadConfig()
            const srcChain = getChain(config, opts.from)
            const dstChain = getChain(config, opts.to)
            if (!srcChain.cctp || !dstChain.cctp) throw new Error('both chains need cctp config')
            if (!dstChain.composer) throw new Error(`SwapComposer is not deployed on ${dstChain.name}`)
            const key = process.env.PRIVATE_KEY
            if (!key) throw new Error('PRIVATE_KEY missing')
            const signer = new ethers.Wallet(key, provider(dstChain))
            const dstDec: number = Number(await new ethers.Contract(dstChain.stables.usdc, ERC20_ABI, signer.provider).decimals())
            const relayFee = ethers.parseUnits(opts.fee, dstDec)

            const irisApi = config.cctp?.irisApi ?? 'https://iris-api.circle.com'
            const url = `${irisApi}/v2/messages/${srcChain.cctp.domain}?transactionHash=${opts.tx}`
            const spin = spinner("fetching Circle's attestation…")
            let messages: { message: string; attestation: string; status: string }[] = []
            for (let i = 0; i < 60; i++) {
                const res = await fetch(url).catch(() => null)
                if (res?.ok) {
                    const body = (await res.json()) as { messages?: typeof messages }
                    messages = (body.messages ?? []).filter((m) => m.status === 'complete')
                    if (messages.length > 0) break
                }
                spin.update(`attestation pending — retry ${i + 1}/60…`)
                await new Promise((resolve) => setTimeout(resolve, 10_000))
            }
            spin.stop()
            if (messages.length === 0) throw new Error('attestation not complete yet — try again later')

            const composer = new ethers.Contract(dstChain.composer, COMPOSER_ABI, signer)
            const transmitter = new ethers.Contract(
                dstChain.cctp.messageTransmitterV2,
                ['function usedNonces(bytes32 nonce) view returns (uint256)'],
                signer.provider
            )
            for (const { message, attestation } of messages) {
                const msgHash = ethers.keccak256(message)
                if (await composer.processedCctpMessages(msgHash)) {
                    note('already processed — skipping')
                    continue
                }
                const nonce = ethers.dataSlice(message, 12, 44)
                const method = (await transmitter.usedNonces(nonce)) > 0n ? 'executeHook' : 'relayAndSwap'
                const s = spinner(`submitting ${method}…`)
                const tx = await composer[method](message, attestation, relayFee)
                const rc = await tx.wait()
                s.stop(`${c.green('✓')} ${method} confirmed ${c.dim(rc.transactionHash)}`)
            }
        })
}
