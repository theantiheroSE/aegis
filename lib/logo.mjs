// lib/logo.mjs — ASCII art "VPS Backup" logo for splash + completion modal.
//
// Two variants:
//   LOGO_FULL    — 20 rows × 174 cols. Use on splash if terminal is large.
//   LOGO_COMPACT — 10 rows × ~78 cols. Use on completion modal / small terms.
//
// getLogo(width) picks the best fit and returns an array of strings (one per
// line) without trailing whitespace. The lines contain only ASCII so they
// can be safely centered in any widget.

export const LOGO_FULL = [
  "VVVVVVVV           VVVVVVVVPPPPPPPPPPPPPPPPP      SSSSSSSSSSSSSSS      BBBBBBBBBBBBBBBBB                                        kkkkkkkk                                                ",
  "V::::::V           V::::::VP::::::::::::::::P   SS:::::::::::::::S     B::::::::::::::::B                                       k::::::k                                                ",
  "V::::::V           V::::::VP::::::PPPPPP:::::P S:::::SSSSSS::::::S     B:::::BBBBBB:::::B                                      k::::::k                                                ",
  "V::::::V           V::::::VPP:::::P     P:::::PS:::::S     SSSSSSS     BB:::::B     B:::::B                                     k::::::k                                                ",
  " V:::::V           V:::::V   P::::P     P:::::PS:::::S                   B::::B     B:::::B  aaaaaaaaaaaaa      cccccccccccccccc k:::::k    kkkkkkkuuuuuu    uuuuuu ppppp   ppppppppp       ",
  "  V:::::V         V:::::V    P::::P     P:::::PS:::::S                   B::::B     B:::::B  a::::::::::::a   cc:::::::::::::::c k:::::k   k:::::k u::::u    u::::u p::::ppp:::::::::p      ",
  "   V:::::V       V:::::V     P::::PPPPPP:::::P  S::::SSSS                B::::BBBBBB:::::B   aaaaaaaaa:::::a c:::::::::::::::::c k:::::k  k:::::k  u::::u    u::::u p:::::::::::::::::p     ",
  "    V:::::V     V:::::V      P:::::::::::::PP    SS::::::SSSSS           B:::::::::::::BB             a::::ac:::::::cccccc:::::c k:::::k k:::::k   u::::u    u::::u pp::::::ppppp::::::p    ",
  "     V:::::V   V:::::V       P::::PPPPPPPPP        SSS::::::::SS         B::::BBBBBB:::::B     aaaaaaa:::::ac::::::c     ccccccc k::::::k:::::k    u::::u    u::::u  p:::::p     p:::::p    ",
  "      V:::::V V:::::V        P::::P                   SSSSSS::::S        B::::B     B:::::B  aa::::::::::::ac:::::c              k:::::::::::k     u::::u    u::::u  p:::::p     p:::::p    ",
  "       V:::::V:::::V         P::::P                        S:::::S       B::::B     B:::::B a::::aaaa::::::ac:::::c              k:::::::::::k     u::::u    u::::u  p:::::p     p:::::p    ",
  "        V:::::::::V          P::::P                        S:::::S       B::::B     B:::::Ba::::a    a:::::ac::::::c     ccccccc k::::::k:::::k    u:::::uuuu:::::u  p:::::p    p::::::p    ",
  "         V:::::::V         PP::::::PP          SSSSSSS     S:::::S     BB:::::BBBBBB::::::Ba::::a    a:::::ac:::::::cccccc:::::ck::::::k k:::::k   u:::::::::::::::uup:::::ppppp:::::::p    ",
  "          V:::::V          P::::::::P          S::::::SSSSSS:::::S     B:::::::::::::::::B a:::::aaaa::::::a c:::::::::::::::::ck::::::k  k:::::k   u:::::::::::::::up::::::::::::::::p     ",
  "           V:::V           P::::::::P          S:::::::::::::::SS      B::::::::::::::::B   a::::::::::aa:::a cc:::::::::::::::ck::::::k   k:::::k   uu::::::::uu:::up::::::::::::::pp      ",
  "            VVV            PPPPPPPPPP           SSSSSSSSSSSSSSS        BBBBBBBBBBBBBBBBB     aaaaaaaaaa  aaaa   cccccccccccccccckkkkkkkk    kkkkkkk    uuuuuuuu  uuuup::::::pppppppp        ",
  "                                                                                                                                                                     p:::::p            ",
  "                                                                                                                                                                     p:::::p            ",
  "                                                                                                                                                                    p:::::::p           ",
  "                                                                                                                                                                    p:::::::p           ",
  "                                                                                                                                                                    p:::::::p           ",
  "                                                                                                                                                                    ppppppppp           ",
];

// 9-row compressed version of the "VPSB" part of the logo. Skips the
// "Backup" suffix because in the full version it extends another 90 columns
// to the right of "VPSB". The caller should render "VPS BACKUP" as a
// separate text line below.
//
// Source: rows 0,2,4,6,8,10,12,14,16 of LOGO_FULL, cols 0..LOGO_COMPACT_SRC_W
// After: replace runs of 2+ spaces with single space, trim.
const LOGO_COMPACT_SRC_W = 100;
const LOGO_COMPACT_MAX_W = 50;
export const LOGO_COMPACT = [
  0, 2, 4, 6, 8, 10, 12, 14, 16,
].map((idx) => {
  const src = LOGO_FULL[idx].slice(0, LOGO_COMPACT_SRC_W);
  return src.replace(/ {2,}/g, " ").replace(/\s+$/, "").slice(0, LOGO_COMPACT_MAX_W);
});

// 5-row tiny version. Use in narrow modals (< 60 cols).
const LOGO_TINY_SRC_W = 70;
const LOGO_TINY_MAX_W = 38;
export const LOGO_TINY = [
  0, 4, 8, 12, 16,
].map((idx) => {
  const src = LOGO_FULL[idx].slice(0, LOGO_TINY_SRC_W);
  return src.replace(/ {2,}/g, " ").replace(/\s+$/, "").slice(0, LOGO_TINY_MAX_W);
});

// Pick the best logo for the terminal width.
// Returns an array of strings (lines) without trailing whitespace.
export function getLogo(width = 80) {
  let logo;
  if (width >= 140) logo = LOGO_FULL;
  else if (width >= 70) logo = LOGO_COMPACT;
  else logo = LOGO_TINY;
  return logo.map((line) => line.replace(/\s+$/, ""));
}

// Center a list of lines within `width` columns. ANSI-aware: ignores escape
// sequences when measuring so colored output stays aligned.
export function centerLines(lines, width) {
  return lines.map((line) => {
    const w = stripAnsi(line).length;
    if (w >= width) return line;
    const left = Math.floor((width - w) / 2);
    return " ".repeat(left) + line;
  });
}

// Cheap ANSI stripper for centering math. Duplicated from colors.mjs to
// avoid a circular import.
function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}
