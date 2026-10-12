// Building blocks for the pane: pure functions of the element table, a palette and data.
import type { Palette, Tone } from './theme'
import { fitCode, shorten } from '../mod/view.js'

type Ui = any

export function tile(ui: Ui, p: Palette, tone: Tone, key: string, children: unknown[]) {
  const { Box } = ui
  const c = p[tone]
  return (
    // No margin of its own: every column of tiles spaces them with gap={1}.
    <Box key={key} flexDirection="column" borderStyle="round" borderColor={c.edge} backgroundColor={c.bg} paddingX={1}>
      {children}
    </Box>
  )
}

// A choice drawn as a row of buttons, never a dropdown: the desktop
// redraws every second and a redraw shut an open dropdown, and in dark mode its options could not
// be read. A dim label, then one Button per option (keys `${key}-${value}`, values are unique); the
// chosen one is primary and pressing it does nothing.
export function choices(ui: Ui, p: Palette, key: string, label: string, value: string, options: { value: string; label: string }[], onPick: (value: string) => void) {
  const { Box, Text, Button } = ui
  return (
    <Box key={key} flexDirection="column">
      {label ? <Text color={p.dim} wrap="wrap">{label}</Text> : null}
      <Box key={`${key}-row`} flexDirection="row" flexWrap="wrap" gap={1}>
        {options.map((o) => (o.value === value
          ? <Button key={`${key}-${o.value}`} variant="primary" label={o.label} onPress={() => {}} />
          : <Button key={`${key}-${o.value}`} label={o.label} onPress={() => onPick(o.value)} />))}
      </Box>
    </Box>
  )
}

// A diff keeps its beginning; logs and output keep their end (the newest lines).
export function codeBlock(ui: Ui, p: Palette, key: string, source: string, format?: 'diff') {
  const text = fitCode(source || ' ', { keep: format === 'diff' ? 'start' : 'end' })
  if (ui.Code) {
    const { Code } = ui
    return <Code key={key} source={text} format={format === 'diff' ? 'diff' : 'source'} wrap="truncate-end" />
  }
  const { Text } = ui
  return <Text key={key} color={p.dim}>{text}</Text>
}

// A folded section: a heading that carries a short summary ("▸ Changes · 2 files · +48 −3"), and its body only
// while open, so a closed fold costs the desktop page almost nothing. `id` names it in the pane's fold state.
export function fold(ui: Ui, p: Palette, id: string, title: string, summary: string, isOpen: boolean, onToggle: () => void, body: () => unknown[]) {
  const { Box, Button } = ui
  return (
    <Box key={`foldbox-${id}`} flexDirection="column">
      <Button key={`fold-${id}`} plain label={`${isOpen ? '▾' : '▸'} ${title}${summary ? ` · ${summary}` : ''}`} onPress={onToggle} />
      {isOpen ? <Box key={`foldbody-${id}`} flexDirection="column" paddingLeft={2} gap={1}>{body()}</Box> : null}
    </Box>
  )
}

// A row that opens its own screen: the title as one line, then dim lines under it. On desktop the title is cut to
// one line (a Button there wraps a long label onto centred lines; about 1.25 characters fit in a cell). With a `tone` the row
// sits in a tile of that state's colour (keyed `item-${id}` all the same, so it is one element to find and measure); the
// tile's border and padding take four cells of the row's width.
export function row(ui: Ui, p: Palette, id: string, title: string, lines: (string | null | undefined)[], onOpen: () => void, firstColor?: string, tone?: Tone) {
  const { Box, Text, Button } = ui
  const room = ui.columns ? Math.floor((ui.columns - (tone ? 8 : 4)) * 1.25) : 0
  const content = [
    <Button key={`open-${id}`} plain label={room > 10 ? shorten(title, room) : title} onPress={onOpen} />,
    ...lines.filter(Boolean).map((line, i) => <Text key={`${id}-line-${i}`} color={i === 0 && firstColor ? firstColor : p.dim} wrap="truncate-end">{line}</Text>),
  ]
  if (tone) return tile(ui, p, tone, `item-${id}`, content)
  return <Box key={`item-${id}`} flexDirection="column">{content}</Box>
}
