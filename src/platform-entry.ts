import { Platform } from "obsidian";

// Build inserts both bundles into these functions. Even their banners remain
// inside the selected function, so mobile never evaluates desktop Node code.
declare function loadMobile(): unknown;
declare function loadDesktop(): unknown;
module.exports = Platform.isMobile ? loadMobile() : loadDesktop();
