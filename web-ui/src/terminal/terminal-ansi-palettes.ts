/**
 * Explicit ANSI palettes for light terminal themes.
 *
 * xterm.js ships a dark-oriented default palette whose reds, greens and
 * yellows are far too pale to read on a white background. Light themes must
 * therefore declare their own palette rather than inheriting those defaults.
 *
 * Dark themes intentionally leave the palette unset so they keep using xterm's
 * defaults, which are already tuned for dark backgrounds.
 */

/** The 16 ANSI colors xterm.js accepts through `ITheme`. */
export interface TerminalAnsiPalette {
	readonly black: string;
	readonly red: string;
	readonly green: string;
	readonly yellow: string;
	readonly blue: string;
	readonly magenta: string;
	readonly cyan: string;
	readonly white: string;
	readonly brightBlack: string;
	readonly brightRed: string;
	readonly brightGreen: string;
	readonly brightYellow: string;
	readonly brightBlue: string;
	readonly brightMagenta: string;
	readonly brightCyan: string;
	readonly brightWhite: string;
}

/**
 * GitHub's light terminal palette: neutral greys plus saturated accents that
 * stay legible on white. Used by every neutral light theme (light, overcast,
 * latte, high-contrast-light).
 */
export const NEUTRAL_LIGHT_ANSI: TerminalAnsiPalette = {
	black: "#24292F",
	red: "#CF222E",
	green: "#116329",
	yellow: "#4D2D00",
	blue: "#0969DA",
	magenta: "#8250DF",
	cyan: "#1B7C83",
	white: "#6E7781",
	brightBlack: "#57606A",
	brightRed: "#A40E26",
	brightGreen: "#1A7F37",
	brightYellow: "#633C01",
	brightBlue: "#218BFF",
	brightMagenta: "#A475F9",
	brightCyan: "#3192AA",
	brightWhite: "#8C959F",
};

/**
 * The canonical Solarized Light palette. Its "bright" row deliberately maps to
 * Solarized's base greys instead of brighter accents, so several entries sit
 * close to the background by design. That is the palette's identity rather than
 * a contrast defect, which is why the palette guard test exempts this theme
 * from the accent-contrast floor.
 */
export const SOLARIZED_LIGHT_ANSI: TerminalAnsiPalette = {
	black: "#073642",
	red: "#DC322F",
	green: "#859900",
	yellow: "#B58900",
	blue: "#268BD2",
	magenta: "#D33682",
	cyan: "#2AA198",
	white: "#EEE8D5",
	brightBlack: "#002B36",
	brightRed: "#CB4B16",
	brightGreen: "#586E75",
	brightYellow: "#657B83",
	brightBlue: "#839496",
	brightMagenta: "#6C71C4",
	brightCyan: "#93A1A1",
	brightWhite: "#FDF6E3",
};

/** Every ANSI key, in xterm's `ITheme` order. */
export const TERMINAL_ANSI_KEYS = [
	"black",
	"red",
	"green",
	"yellow",
	"blue",
	"magenta",
	"cyan",
	"white",
	"brightBlack",
	"brightRed",
	"brightGreen",
	"brightYellow",
	"brightBlue",
	"brightMagenta",
	"brightCyan",
	"brightWhite",
] as const satisfies readonly (keyof TerminalAnsiPalette)[];
