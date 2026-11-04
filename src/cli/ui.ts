/** Terminal UI helpers: zero-dependency colors, tables, spinner, confirm. */
import readline from 'readline'

const tty = process.stdout.isTTY && !process.env.NO_COLOR
const err = (s: string) => process.stderr.write(s + '\n')

/** Machine output: one JSON value per line on stdout, nothing else mixed in. */
export const emitJson = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n')

const wrap = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s)
export const c = {
    bold: wrap(1),
    dim: wrap(2),
    red: wrap(31),
    green: wrap(32),
    yellow: wrap(33),
    cyan: wrap(36),
    magenta: wrap(35),
}

// Status/decoration goes to stderr so stdout stays parseable for agents.
export const ok = (s: string) => err(`${c.green('✓')} ${s}`)
export const fail = (s: string) => err(`${c.red('✗')} ${s}`)
export const warn = (s: string) => err(`${c.yellow('!')} ${s}`)
export const note = (s: string) => err(c.dim(s))

/** Aligned two-column key/value block. */
export function kv(rows: [string, string][]): void {
    const w = Math.max(...rows.map(([k]) => k.length))
    for (const [k, v] of rows) console.log(`  ${c.dim(k.padEnd(w))}  ${v}`)
}

/** Aligned table with a dim header row. */
export function table(headers: string[], rows: string[][]): void {
    const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
    const widths = headers.map((h, i) => Math.max(strip(h).length, ...rows.map((r) => strip(r[i] ?? '').length)))
    const fmt = (cells: string[]) =>
        cells.map((cell, i) => cell + ' '.repeat(widths[i] - strip(cell).length)).join('  ')
    console.log(c.dim(fmt(headers)))
    for (const r of rows) console.log(fmt(r))
}

/** y/N prompt; resolves false on anything but y/yes. */
export function confirm(question: string): Promise<boolean> {
    if (!process.stdin.isTTY) return Promise.resolve(false)
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    return new Promise((resolve) => {
        rl.question(`${question} ${c.dim('[y/N]')} `, (answer) => {
            rl.close()
            resolve(/^y(es)?$/i.test(answer.trim()))
        })
    })
}

/** Minimal line spinner; inert when not a TTY. */
export function spinner(label: string): { update: (s: string) => void; stop: (finalLine?: string) => void } {
    if (!process.stderr.isTTY) {
        err(label)
        return { update: (s) => err(s), stop: (f) => f && err(f) }
    }
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
    let i = 0
    let text = label
    const timer = setInterval(() => {
        process.stderr.write(`\r${c.cyan(frames[(i = (i + 1) % frames.length)])} ${text}\x1b[K`)
    }, 80)
    return {
        update: (s: string) => {
            text = s
        },
        stop: (finalLine?: string) => {
            clearInterval(timer)
            process.stderr.write('\r\x1b[K')
            if (finalLine) err(finalLine)
        },
    }
}
