// How the desktop Client draws the pane's controls. The Client paints a
// Button with no chrome, stretched across its row with the label centred, and an Input
// with no border. These wrap the table's Button and Input so the shared screens read the
// same on both surfaces; the terminal keeps its own table untouched.
// A filled Box reads as highlighted text there (it fills only the text's own line), so
// a button is an outlined box like the agent chips; the label carries the padding, so
// every cell inside the outline is the Button.
import type { Palette } from '../theme'
import { codeLines, lineCost, CODE_LINES } from '../../mod/client.js'

export function clientLook(el: any, p: Palette, columns = 0) {
  const { Box, Text, Button, Input } = el
  const LookButton = (props: any) => {
    const { children, ...rest } = props
    const label = String(rest.label ?? (typeof children === 'string' ? children : ''))
    // Anything that does something is outlined. Text stays
    // only where its symbol says it is a control (a tick, a fold arrow, a picked dot, a
    // thumb). Row titles and step rows open a page: text with a › after it.
    const key = String(rest.key ?? '')
    const opens = /^(open|step)-/.test(key)
    const symbol = /^[☐☑▾▸●👍👎✕]/u.test(label)
    // A row of its own keeps the Button to its label's width, left-aligned; it may
    // still shrink, so a long title beside a badge gives way instead of running under it.
    // A quiet link: text, no outline, no ›.
    const link = /^link-/.test(key)
    if (opens || symbol || link) return <Box flexDirection="row" minWidth={0}><Button {...rest} plain label={opens ? `${label} ›` : label} /></Box>
    const primary = rest.variant === 'primary'
    // Anything that ends something: outlined in the danger colour. It asks before acting.
    const ends = /^end-/.test(key)
    delete rest.plain
    return (
      <Box flexDirection="row" flexShrink={0}>
        <Box borderStyle="round" borderColor={primary ? p.working.edge : ends ? p.failed.edge : p.neutral.edge} {...(primary ? { backgroundColor: p.working.bg } : {})}>
          <Button {...rest} label={` ${label} `} />
        </Box>
      </Box>
    )
  }
  // The label above, the field in a box of its own.
  const LookInput = (props: any) => {
    const { label, ...rest } = props
    return (
      <Box flexDirection="column">
        {label ? <Text color={p.dim}>{label}</Text> : null}
        <Box borderStyle="round" borderColor={p.neutral.edge} paddingX={1}><Input {...rest} /></Box>
      </Box>
    )
  }
  // The desktop page draws no Code, Link or Markdown: one of them in the tree and the
  // page throws the whole pane away (blank). Code is a column of Text lines, one per line, cut like the Code was;
  // a diff colours its added and removed lines. Code is capped per block and per screen (this table is made for
  // each drawing), in lines and in characters of drawing; a block's own Box and its "… more lines" note count as
  // lines too, so code stays under SCREEN_LINES × 2 nodes and SCREEN_CODE_CHARS, plus one node for each block past
  // the budget: once it is spent, the next block says so once and the rest are an empty Box. The detail's worst
  // case (150 open files) stays under the page's 2,000 nodes and the Client's 100,000 characters.
  let codeLeft = SCREEN_LINES
  let charsLeft = SCREEN_CODE_CHARS
  let saidFull = false
  const tones: Record<string, string | undefined> = { added: p.ok.text, removed: p.failed.text, head: p.dim, dim: p.dim, plain: undefined }
  const LookCode = (props: any) => {
    const isDiff = props.format === 'diff'
    const room = Math.min(CODE_LINES, codeLeft - 2)
    // Its Box and its note: about 200 characters.
    const roomChars = charsLeft - 200
    if (room < 1 || roomChars < lineCost('')) {
      if (saidFull) return <Box />
      saidFull = true
      return <Text key={props.key} color={p.dim} wrap="wrap">… not shown: this screen already shows all the code it can. Close some files to see more.</Text>
    }
    const { lines, used } = codeLines(props.source, { format: isDiff ? 'diff' : 'source', max: room, maxChars: roomChars })
    codeLeft -= used + 1 + (lines.length > used ? 1 : 0)
    charsLeft -= 200 + lines.reduce((n: number, l: { text: string }) => n + lineCost(l.text), 0)
    return (
      <Box key={props.key} flexDirection="column">
        {lines.map((l: { text: string; tone: string }) => {
          const color = tones[l.tone]
          return color ? <Text color={color} wrap="truncate-end">{l.text}</Text> : <Text wrap="truncate-end">{l.text}</Text>
        })}
      </Box>
    )
  }
  // A link is its text, with the address dim after it when they differ (the Client has no way to open one).
  // Through `h` its text arrives as children, a list.
  const LookLink = (props: any) => {
    const href = String(props.href ?? '')
    const said = [].concat(props.children ?? []).filter((c: unknown) => typeof c === 'string' || typeof c === 'number').join('')
    const text = String(props.label ?? said) || href
    return <Text wrap="wrap">{text}{text !== href && href ? <Text color={p.dim}>{` ${href}`}</Text> : null}</Text>
  }
  const LookMarkdown = (props: any) => (props.dimColor
    ? <Text color={p.dim} wrap="wrap">{String(props.text ?? '')}</Text>
    : <Text wrap="wrap">{String(props.text ?? '')}</Text>)
  // columns: how wide the Client is, for screens that cut a label to one line.
  return { ...el, Button: LookButton, Input: LookInput, Code: LookCode, Link: LookLink, Markdown: LookMarkdown, columns }
}

// Lines of code one screen draws in all, across its code blocks, and the characters of drawing they may take
// (a Client tree is at most 100,000; the file rows take up to ROW_CHARS, mod/client.js).
export const SCREEN_LINES = 300
export const SCREEN_CODE_CHARS = 20_000
