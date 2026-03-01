---
name: material-symbols-v3
description: Material Symbols v3 variable icon font system. Use when adding icons to buttons, navigation, status indicators, or any UI element. Provides 2,500+ icons with fill, weight, grade, and optical size axes. Integrates with project color tokens.
allowed-tools: Read, Write, Edit, Glob, Grep
---

# Material Symbols v3

Material Design 3 icon system using variable fonts. This project uses Material Symbols Outlined loaded from Google Fonts CDN.

## Project Setup

```css
@import url('https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=swap');
```

## Basic Usage

```html
<span class="icon">home</span>
<span class="icon icon--filled">favorite</span>
```

## Icon Sizes

| Class | Size | Optical Size | Use Case |
|-------|------|--------------|----------|
| `.icon--sm` | 20px | 20 | Dense UI, inline text |
| `.icon--md` | 24px | 24 | Default, buttons |
| `.icon--lg` | 40px | 40 | Emphasis, headers |
| `.icon--xl` | 48px | 48 | Hero sections |

## Common Icons

| Icon Name | Usage |
|-----------|-------|
| `menu` | Hamburger menu |
| `add` | Create new |
| `send` | Send message |
| `attach_file` | File attachment |
| `close` | Close/dismiss |
| `search` | Search |
| `settings` | Settings |
| `chat` | Chat/conversations |
| `edit` | Edit/modify |
| `delete` | Remove |
| `check_circle` | Success |
| `error` | Error state |
| `info` | Information |
