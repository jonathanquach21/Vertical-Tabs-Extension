# Chrome Vertical Tabs & Tab Group Manager

A Chrome extension that organizes open tabs in a clean vertical sidebar. It combines custom tab groups, drag-and-drop organization, group focus mode, search, and quick tab controls in a native Chrome Side Panel.

## Features

- Native Chrome Side Panel for persistent vertical tab management
- Default, Tabs, and Groups views
- Create, rename, delete, restore, and recolor custom tab groups
- Drag and drop tabs and groups to organize them in a custom order
- Focus mode that shows one selected group while keeping other tabs open
- Hidden groups dropdown for quickly switching between groups in focus mode
- Group-aware new tabs from the plus button, `Ctrl+T`, and `Cmd+T`
- Search tabs by title or URL
- Sort tabs by custom order, newest, oldest, or alphabetical order
- Right-click controls for rename, mute, reload, bookmark, duplicate, pin, close, and move-to-group actions
- Loading, audio, muted, and tab count indicators
- Custom group colors, font size, font color, theme, and tab-time display
- Deleted-group restore history with a clear-history option
- Separate regular and incognito tab/group state
- Restart-safe persistence that reconnects organized tabs when Chrome assigns new tab IDs
- Default extension shortcut: `Alt+V` on Windows/Linux and `Option+V` on macOS

## Installation

1. Download or clone this repository.
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select the project folder containing `manifest.json`.
6. Click the extension icon to open the Side Panel.

## Usage

- Click a group name to focus that group in Chrome.
- Click **Show all** to restore the other tabs.
- While a group is focused, use the plus button or `Ctrl+T`/`Cmd+T` to create a tab inside that group.
- Right-click a tab or group to open its available actions.
- Open Settings to customize the theme, colors, font, search placement, tab dates, and new-tab button.

## Project Structure

| File or folder | Purpose |
| --- | --- |
| `manifest.json` | Chrome Manifest V3 configuration and permissions |
| `background.js` | Tab, group, focus-mode, shortcut, and storage logic |
| `content.js` | Side Panel interface and user interactions |
| `sidebar.css` | Sidebar layout, theme, menu, and interaction styles |
| `sidebar.html` | Side Panel entry page |
| `icons/` | Extension icons |

## Technologies

- JavaScript
- HTML
- CSS
- Chrome Extensions Manifest V3
- Chrome Tabs, Tab Groups, Storage, Bookmarks, Commands, and Side Panel APIs

## Known Chrome Limitations

- Chrome controls the Side Panel's final left/right position and outer width. The extension can display the current side, but Chrome does not provide a general extension setting to force that browser-level preference.
- Chrome or the operating system may reserve a keyboard shortcut if it conflicts with an existing browser or system shortcut.
- Chrome-restricted pages may limit some tab-page interactions, but the native Side Panel remains available where Chrome permits it.

## Status

This project is an actively refined personal Chrome extension focused on improving tab organization and reducing sidebar clutter.
