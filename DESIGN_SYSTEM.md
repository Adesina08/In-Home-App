# INICIO Design System — visual redesign pass

This is a **styling-only** pass across every EJS view. Read this file, then read
`views/admin/dashboard.ejs` and `views/login.ejs` as the finished reference
implementations of these conventions before editing your assigned files.

## Hard rules — do not break functionality
- Do NOT rename, remove, or add form field `name`/`id` attributes, route paths, `action`/`href`
  targets, `<%= %>`/`<%- %>` EJS expressions, or JS variable names referenced by inline `<script>`
  blocks. Every button, link, and form must still submit to the same place with the same data.
- Do NOT remove any `<%- include(...) %>` calls (header/footer/study_tabs) or change their arguments
  unless a page is missing `manifestUrl`/`user`/`title` locals it already had.
- Keep every conditional (`<% if %>`, `<% forEach %>`) intact — only touch the HTML/class markup
  inside them.
- `icon(name, classes)` is available as a global in every view (from `app.locals.icon`, see
  `lib/icons.js` for the full name list: home, chart-bar, clipboard, users, chat, cog, video, mic,
  check, check-circle, warning, arrow-right, plus, upload, eye, logout, menu, bell, calendar, photo,
  trend, building, shield, smartphone, x, refresh). Use `<%- icon('name', 'w-4 h-4') %>` (note `<%-`
  not `<%=`, it returns raw SVG markup).

## Design tokens (already in tailwind.config.js)
- Brand navy scale: `brand-50` … `brand-900` (default `brand` = `brand-700` = `#1F3864`), plus `brand-light`/`brand-500`.
- Semantic status colors already used app-wide: `badge-green` / `badge-amber` / `badge-red` (CSS
  classes defined in header.ejs `<style>`, keep using them for QC/risk badges — don't redefine).
- Shadows: `shadow-card` (resting), `shadow-card-hover` (hover), `shadow-pop` (modals/prominent cards).
- Radii: prefer `rounded-xl` (14px) for buttons/inputs/tabs, `rounded-2xl` (20px) for cards/panels,
  `rounded-full` for pills/badges/avatars.

## Component patterns to apply consistently

**Page header** (top of every page body, right after the header include):
```html
<div class="flex flex-wrap items-center justify-between gap-4 mb-6">
  <div>
    <div class="text-xs font-semibold text-brand-500 uppercase tracking-wide mb-0.5">Section label</div>
    <h1 class="text-2xl font-bold text-slate-900">Page Title</h1>
    <p class="text-slate-500 text-sm mt-1">Optional subtitle/description</p>
  </div>
  <div class="flex gap-2"> <!-- primary actions --> </div>
</div>
```
Study-config sub-pages already get this from `study_tabs.ejs` — don't duplicate a second H1 on those,
just make sure the page content below it follows the card patterns below.

**Card / panel**: `bg-white rounded-2xl border border-slate-200/70 p-5 shadow-card` (add
`hover:shadow-card-hover transition` on cards that are primarily informational, skip it on cards that
contain forms/tables that don't need a hover affordance).

**Stat card** (small KPI number): icon chip (`w-7 h-7 rounded-lg bg-{color}-50 text-{color}-600 flex
items-center justify-center`) + uppercase label next to it, big bold number below — see dashboard.ejs
`RESPONDENTS`/`DIARY RECORDS` cards for the exact pattern.

**Buttons**:
- Primary: `inline-flex items-center gap-1.5 bg-brand-700 text-white rounded-xl px-4 py-2.5 text-sm font-semibold hover:bg-brand-600 transition shadow-card`
- Secondary/outline: `inline-flex items-center gap-1.5 bg-white border border-slate-300 rounded-xl px-4 py-2.5 text-sm font-medium hover:bg-slate-50 hover:border-slate-400 transition shadow-card`
- Small/table-row action: same as above but `px-3 py-1.5 text-xs`
- Destructive: swap `bg-brand-700`/`hover:bg-brand-600` for `bg-red-600`/`hover:bg-red-700`, or for
  outline destructive use `border-red-300 text-red-600 hover:bg-red-50`
- Always pair with a relevant `icon(...)` where one fits naturally (plus, upload, eye, check, x, arrow-right, refresh).

**Form inputs**: `w-full border border-slate-300 rounded-xl px-3.5 py-2.5 text-sm focus:outline-none
focus:ring-2 focus:ring-brand-400 focus:border-brand-400 transition`. Labels:
`block text-sm font-medium text-slate-600 mb-1.5`.

**Tables**: wrap in `<div class="overflow-x-auto">`. Header row: `text-left text-slate-400 text-xs
uppercase tracking-wide`. Body rows: `border-t border-slate-100 hover:bg-slate-50/70`. Cell padding
`py-2.5` (or `py-2` for dense admin tables).

**Empty states**: a centered muted row/block, e.g. `<td colspan="N" class="py-3 text-slate-400">No … yet</td>`
or for a full empty section: icon + one-line message inside a dashed-border box
(`border-2 border-dashed border-slate-200 rounded-2xl p-8 text-center text-slate-400`).

**Badges/pills**: `text-xs px-2.5 py-1 rounded-full font-medium` combined with `badge-green`/
`badge-amber`/`badge-red`, or `bg-slate-100 text-slate-600` for neutral.

**Tabs already inside `study_tabs.ejs`** — no changes needed there, just make sure content below
matches card conventions.

## What "nicely designed" means here
Generous whitespace, one clear visual hierarchy per page (label → title → content), icon-accented
section headers, colored icon chips on stat cards (vary the color per card — brand/sky/emerald/amber/
violet — for visual rhythm, not all the same color), soft shadows instead of heavy borders, rounded-xl+
everywhere (no sharp corners), and consistent button styling. Avoid adding new colors outside the
palette above. Avoid walls of default black text — use `text-slate-900` for headings, `text-slate-600`
for body, `text-slate-400`/`text-slate-500` for meta/secondary text.
