# Fera Design System — Hard Rules

All UI elements MUST follow these rules. No exceptions.

---

## Color Palette

### Backgrounds
| Token | Hex | Usage |
|-------|-----|-------|
| `bg-base` | `#0c111d` | App background, grid rows (odd) |
| `bg-raised` | `rgba(255,255,255,0.03)` | Headers, elevated surfaces, grid rows (even) |
| `bg-surface` | `#141a2e` | Modals, dropdowns, popovers |
| `bg-hover` | `rgba(86,156,214,0.08)` | Row hover, interactive hover |
| `bg-selected` | `rgba(86,156,214,0.15)` | Selected rows, active states |
| `bg-input` | `rgba(255,255,255,0.04)` | Input fields, selects, textareas |

### Text
| Token | Value | Usage |
|-------|-------|-------|
| `text-primary` | `#ffffff` | Headings, values, important data |
| `text-secondary` | `rgba(255,255,255,0.7)` | Grid cell text, body content |
| `text-tertiary` | `rgba(255,255,255,0.45)` | Sidebar items, secondary labels |
| `text-muted` | `rgba(255,255,255,0.25)` | Column headers, micro-labels |
| `text-ghost` | `rgba(255,255,255,0.12)` | Placeholders, empty states, disabled |

### Accent Colors
| Token | Hex | Usage |
|-------|-----|-------|
| `accent-blue` | `#569cd6` | Active tabs, highlights, links, "All" row |
| `accent-green` | `#4ec9b0` | Success, "crawling" status, start button |
| `accent-yellow` | `#dcdcaa` | Warnings, 3xx status codes |
| `accent-red` | `#f44747` | Errors, 4xx/5xx status, stop button |
| `accent-purple` | `#c586c0` | Images resource type |
| `accent-orange` | `#d7ba7d` | Other/unknown |

### Borders
| Token | Value | Usage |
|-------|-------|-------|
| `border-subtle` | `rgba(255,255,255,0.04)` | Grid cell dividers, row separators |
| `border-default` | `rgba(255,255,255,0.08)` | Panel dividers, section borders |
| `border-input` | `rgba(255,255,255,0.12)` | Input borders, button borders |
| `border-focus` | `rgba(86,156,214,0.5)` | Focused inputs, active elements |

---

## Typography

### Font Stack
```
Primary: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif
Mono:    'SF Mono', 'Cascadia Code', 'Consolas', monospace
```

### Scale (all sizes are MANDATORY — do not deviate)
| Token | Size | Weight | Tracking | Usage |
|-------|------|--------|----------|-------|
| `type-micro` | 8px | 600 | 1.5px | Micro-labels (column headers, sidebar headers) |
| `type-label` | 9px | 700 | 1.2px | Section labels, button text, telem labels |
| `type-small` | 10px | 600 | 0.5px | Tab text, sidebar items, legend |
| `type-body` | 11px | 400 | 0 | Grid cells, detail values, dropdown items |
| `type-data` | 12px | 600 | 0 | Status values, URL input, data readouts |
| `type-number` | 16px | 700 | 0 | Numeric telemetry readouts |
| `type-heading` | 14px | 700 | 1px | Logo name, modal section titles |

### Rules
- ALL labels and column headers: `text-transform: uppercase`
- ALL numeric displays: `font-variant-numeric: tabular-nums`
- Monospace font for: URLs, code values, detail panel values
- NEVER use font-size above 16px except the About modal logo (30px)

---

## Spacing

### Base Unit: 4px

All spacing MUST be a multiple of 4px.

| Token | Value | Usage |
|-------|-------|-------|
| `space-1` | 4px | Minimum gap between inline elements |
| `space-2` | 6px | Tight padding (pills, compact buttons) |
| `space-3` | 8px | Standard inner padding, icon gaps |
| `space-4` | 10px | Input horizontal padding |
| `space-5` | 12px | Section padding, panel gutters |
| `space-6` | 14px | Modal body gaps between fields |
| `space-7` | 16px | Telemetry bar padding, major section gaps |
| `space-8` | 20px | Modal header/footer padding |

### Component Padding
| Component | Padding |
|-----------|---------|
| Telemetry bar | `8px 16px` |
| Grid cell | `4px 8px` |
| Grid header cell | `6px 8px` |
| Tab button | `6px 12px` |
| Pill button | `6px 16px` |
| Input field | `6px 16px` (pill) or `8px 12px` (rect) |
| Modal header | `14px 20px` |
| Modal body | `20px` |
| Dropdown item | `7px 14px` |
| Status bar | `3px 12px` |

---

## Border Radius

### Hard Rules
| Element | Radius | Notes |
|---------|--------|-------|
| Pill buttons (Start, Clear, Export) | `20px` | Always fully rounded |
| Input fields in toolbar | `20px` | Pill shape |
| Dropdown menus | `8px` | Soft round |
| Dropdown items (hover bg) | `5px` | Subtle round |
| Modal containers | `12px` | Prominent round |
| Modal inputs/selects | `8px` | Soft round |
| Filter bar controls | `14px` | Semi-pill |
| Tech badges / tags | `14px` | Semi-pill |
| Status dots | `50%` | Perfect circle |
| Grid cells | `0` | Never rounded |
| Tab underline indicators | `0` | Flat 2px line |

### Rule
- If it's a **standalone button** → `border-radius: 20px`
- If it's inside a **modal form** → `border-radius: 8px`
- If it's a **filter/toolbar control** → `border-radius: 14px`
- If it's a **container/panel** → `border-radius: 12px`
- If it's a **data element** (grid, table, status bar) → `border-radius: 0`

---

## Select Fields

ALL `<select>` elements MUST be custom-styled. No native browser chrome.

### Rules
- `appearance: none; -webkit-appearance: none;`
- Custom chevron via inline SVG background: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='rgba(255,255,255,0.4)'/%3E%3C/svg%3E") no-repeat right <offset> center`
- Right padding must account for chevron: add 18px extra on the right
- Font: primary system stack (not monospace), `font-weight: 600`, `letter-spacing: 0.5px`
- Font size: `type-small` (10px) for toolbar/filter selects; `type-body` (11px) for modal selects

### Toolbar / Filter Bar Select
```css
padding: 4–6px 28px 4–6px 12px;
border: 1px solid rgba(255,255,255,0.12);  /* border-input */
border-radius: 14px;                        /* filter bar control */
background: bg-input + chevron SVG at right 10px center;
color: text-primary;
font-size: 10px;
```

### Modal Select
```css
padding: 8px 28px 8px 12px;
border: 1px solid rgba(255,255,255,0.12);  /* border-input */
border-radius: 8px;                         /* modal input */
background: bg-input + chevron SVG at right 10px center;
color: text-primary;
font-size: 11px;
```

### `<option>` Elements
```css
background: bg-surface (#141a2e);
color: text-primary (#ffffff);
font-size: 11px;
```

### Focus State
- `border-color: border-focus`
- `box-shadow: 0 0 0 2px rgba(86,156,214,0.1)`

---

## Data Grid

### Row Backgrounds
- ALL rows (odd AND even): `bg-base` (`#0c111d`) — **NO alternating stripes**
- Hover: `bg-hover`
- Selected: `bg-selected`

### Font
- Must use the **primary system font stack** — same as all other UI
- Cell text: `type-body` (11px, weight 400)
- Header text: `type-micro` (8px, weight 600, letter-spacing 1.5px, uppercase)
- Row numbers: `type-small` (10px), `font-variant-numeric: tabular-nums`

### Borders
- Row borders: `border-subtle` (`rgba(255,255,255,0.04)`)
- Cell right borders: `border-subtle`
- Header bottom: `border-default` (`rgba(255,255,255,0.08)`)
- Row number column right: `border-default`

---

## Borders & Dividers

- Panel dividers: `1px solid rgba(255,255,255,0.06)`
- Grid row borders: `1px solid rgba(255,255,255,0.04)`
- Input borders: `1px solid rgba(255,255,255,0.12)` → focus: `rgba(86,156,214,0.5)`
- Button borders: `1px solid rgba(255,255,255,0.12)` or accent-colored at 30% opacity
- NEVER use solid opaque borders — always use rgba white or rgba accent

---

## Interactive States

### Focus
- Border transitions to `border-focus` (`rgba(86,156,214,0.5)`)
- Add `box-shadow: 0 0 0 2px rgba(86,156,214,0.1)`
- Transition: `0.2s`

### Hover
- Buttons: increase border opacity, add subtle box-shadow glow
- Grid rows: `bg-hover`
- Dropdown items: `rgba(86,156,214,0.15)` background, text to white
- Tabs: text color to `rgba(255,255,255,0.6)`

### Active/Selected
- Tabs: `accent-blue` color + 2px bottom border in `accent-blue`
- Grid rows: `bg-selected`, text to `text-primary`
- Sidebar "All" row: `rgba(86,156,214,0.1)` bg, text `accent-blue`

### Disabled
- `opacity: 0.25`
- `cursor: default`

---

## Shadows

| Usage | Shadow |
|-------|--------|
| Dropdowns | `0 12px 40px rgba(0,0,0,0.5)` |
| Modals | `0 20px 60px rgba(0,0,0,0.5)` |
| Logo icon | `filter: drop-shadow(0 0 8px rgba(86,156,214,0.5))` |
| Glow effects (status dots) | `box-shadow: 0 0 8px <color at 60%>` |

- NEVER use elevation shadows on panels/sidebars — use border dividers only
- Backdrop blur on overlays: `backdrop-filter: blur(6px)`

---

## Transitions

- All interactive transitions: `0.15s` ease
- Focus ring transitions: `0.2s`
- Progress bar width: `0.3s ease`
- Pulse animation (crawling dot): `1.5s infinite`

---

## Layout Rules

### Telemetry Bar
- Single horizontal flex row
- Logo group → divider → status → URL input → scope → URLs found → divider → action buttons
- URL input: `flex: 0 1 320px` (max ~1/3 of bar)
- Dividers: `1px wide, 28px tall, rgba(255,255,255,0.08)`

### Main Content
- Horizontal flex: left panels (flex: 1) + right sidebar (fixed 250px)
- Left panels: vertical flex: grid (flex: 1) → status bar → bottom panel (180px)

### Right Sidebar
- Width: `250px`, min-width: `210px`
- Tree indentation: level 1 = `18px`, level 2 = `30px`

### Bottom Panel
- Height: `180px`, min-height: `140px`
- Tabs on top (horizontal), content below, status bar at bottom

---

## Component Checklist

When creating ANY new component, verify:

1. [ ] Background uses `bg-base`, `bg-raised`, or `bg-surface` — never custom
2. [ ] Text colors from the text scale — never custom grays
3. [ ] Border radius follows the element-type rules above
4. [ ] All spacing is a multiple of 4px
5. [ ] Font sizes from the type scale — never custom sizes
6. [ ] Labels are uppercase with letter-spacing
7. [ ] Borders use rgba(255,255,255,_) — never opaque
8. [ ] Interactive states (hover, focus, active, disabled) are all defined
9. [ ] Transitions on all interactive properties
10. [ ] No box-shadows on flat panels — only on floating elements
