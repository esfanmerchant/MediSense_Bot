/**
 * Every Material Symbol this application asks for, read off the source.
 *
 * Google serves the full Material Symbols variable font — every icon, every
 * axis — as a **3.8 MB** woff2. Naming the icons we use turns that into a few
 * kilobytes. The catch is that an icon left off the list has no glyph, and a
 * Material Symbol with no glyph renders its own name as text: "monitor_heart"
 * where an icon should be. That failure has already happened once in this
 * project, so the list is never written by hand — it is extracted from the
 * source by this file, and a test re-runs the extraction and fails if the
 * two disagree.
 *
 * What it looks for, which is every shape an icon name takes here:
 *
 *   <Icon name="pill" />           JSX prop, the common case
 *   icon="calendar_today"          JSX prop on a wrapper that forwards it
 *   { icon: "hourglass_top" }      a data array the component maps over
 *   cond ? "undo" : "arrow_outward"  a ternary in an icon position
 *
 * The last two are why this cannot just scan JSX: roughly a third of the icons
 * in this app reach `<Icon>` through a variable.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SRC = join(HERE, "..", "src");

/** Anything that could plausibly be an icon name, before filtering. */
const CANDIDATE = /^[a-z][a-z0-9_]{1,39}$/;

/**
 * Words that match the shape of an icon name but cannot be one.
 *
 * Almost empty, and it stays that way. A denylist was tried with the obvious
 * entries — "search", "email", "menu", "image" — and every one of them turned
 * out to be a real Material Symbol; "search" shipped as the literal word
 * inside five pages before a browser check caught it. Names Google does not
 * recognise are ignored and cost a few bytes of URL; a name wrongly excluded
 * costs a word where an icon should be. So the bias is entirely towards
 * including, and only values that are structurally impossible are dropped.
 */
const NOT_ICONS = new Set(["true", "false", "null", "undefined"]);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (/\.(tsx?|jsx?)$/.test(entry) && !/\.test\./.test(entry)) out.push(path);
  }
  return out;
}

/**
 * Pull icon names out of one file.
 *
 * Each pattern is anchored on something that means "this string is an icon":
 * the prop name, or the `icon:` key. A bare string literal is never taken.
 */
function fromSource(source) {
  const found = new Set();

  const add = (value) => {
    if (value && CANDIDATE.test(value) && !NOT_ICONS.has(value)) found.add(value);
  };

  // <Icon name="pill" />, icon="pill", iconName="pill"
  for (const m of source.matchAll(/\b(?:name|icon|iconName|leadingIcon|trailingIcon)=\{?"([^"]+)"\}?/g)) {
    add(m[1]);
  }

  // { icon: "pill" } — a data array the component maps over.
  for (const m of source.matchAll(/\bicon\s*:\s*"([^"]+)"/g)) add(m[1]);

  // A ternary in an icon position: name={x ? "undo" : "arrow_outward"}
  for (const m of source.matchAll(/\b(?:name|icon)=\{[^}]*\}/g)) {
    for (const s of m[0].matchAll(/"([^"]+)"/g)) add(s[1]);
  }

  // `<Icon name={...}>` where the value is built from a lookup table whose
  // values are string literals on their own lines.
  for (const m of source.matchAll(/^\s*[A-Z_]*\s*"?[\w-]+"?\s*:\s*"([a-z][a-z0-9_]{2,39})",?\s*$/gm)) {
    // Only when the file also renders an Icon — otherwise this matches any map.
    if (/\bIcon\b/.test(source)) add(m[1]);
  }

  // A helper that *chooses* an icon: `function iconFor(...) { … return "login" }`.
  // Six of these exist here, and some of the names they return appear nowhere
  // else in the source — `/admin/audit` shipped the literal word "login" ten
  // times over before a browser check found it. Anchored on the function's own
  // name, so it does not sweep in unrelated returns from the rest of the file.
  for (const fn of source.matchAll(/(?:function|const)\s+\w*[Ii]con\w*\s*[(=][\s\S]*?\n\}/g)) {
    for (const s of fn[0].matchAll(/return\s+"([a-z][a-z0-9_]{2,39})"/g)) add(s[1]);
    for (const s of fn[0].matchAll(/\?\s*"([a-z][a-z0-9_]{2,39})"\s*:/g)) add(s[1]);
    for (const s of fn[0].matchAll(/:\s*"([a-z][a-z0-9_]{2,39})"/g)) add(s[1]);
  }

  return found;
}

export function iconNames() {
  const all = new Set();
  for (const file of walk(SRC)) {
    for (const name of fromSource(readFileSync(file, "utf8"))) all.add(name);
  }
  return [...all].sort();
}

/** Where the generated list lives — both the writer and the test need it. */
export const GENERATED = join(SRC, "app", "icon-names.generated.ts");

const HEADER = [
  "/**",
  " * Every Material Symbol this application uses. **Generated — do not edit.**",
  " *",
  " * Regenerate with:  npm run icons",
  " *",
  " * Google serves the whole Material Symbols variable font as a 3.8 MB woff2.",
  " * Naming what we use brings that to about 220 KB. The risk runs the other",
  " * way: an icon missing from this list has no glyph, and a Material Symbol",
  " * with no glyph renders its own name as text — \"monitor_heart\" where an icon",
  " * should be, at whatever size its parent sets. That has happened here before.",
  " *",
  " * So this file is extracted from the source rather than maintained, and",
  " * icon-names.test.ts re-runs the extraction and fails if the two disagree.",
  " * A handful of entries are not real icons: the extractor errs towards",
  " * including, and Google ignores a name it does not recognise.",
  " */",
  "",
  "export const ICON_NAMES = [",
].join("\n");

export function render(names) {
  return `${HEADER}\n${names.map((n) => `  "${n}",`).join("\n")}\n] as const;\n`;
}

// `file://` plus a Windows path is not the string node puts in
// `import.meta.url`, so the comparison goes through `pathToFileURL`.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const names = iconNames();
  if (process.argv[2] === "--write") {
    writeFileSync(GENERATED, render(names), "utf8");
    console.log(`wrote ${names.length} icons to ${GENERATED}`);
  } else if (process.argv[2] === "--url") {
    console.log(
      "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&icon_names=" +
        names.join(",") +
        "&display=block",
    );
  } else {
    console.log(names.join("\n"));
    console.error(`\n${names.length} icons`);
  }
}
