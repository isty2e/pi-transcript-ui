import { join } from "node:path";
import { getPackageDir, type Theme } from "@earendil-works/pi-coding-agent";

const hostTheme = await import(join(getPackageDir(), "dist/modes/interactive/theme/theme.js")) as { theme: Theme };

export const theme = hostTheme.theme;
