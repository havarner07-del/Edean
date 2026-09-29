# TI-84 Plus CE programs (TI-BASIC)

These work on any **TI-84 Plus CE** (color screen), with or without Python.
You need OS 5.2 or newer, which almost every CE already has.

## Install

1. Install **TI Connect CE** on your computer and plug in the calculator.
2. Select **all 15 `.8xp` files** in this folder and drag them onto the calculator.
   The main programs need the `Z...` helper programs to work.
3. Press `prgm`, pick a program, and press `enter` twice.

Run only these five. The `Z...` programs are helpers and aren't meant to be run on their own.

| Program | Sections | What it does |
|---------|----------|--------------|
| `CONICS` | 10.1–10.3 | Ellipse/circle, hyperbola, parabola. Works from the standard equation, from features (a, b, c, focus, directrix) or from general form (completes the square). Shows center, vertices, co-vertices, foci, a/b/c, eccentricity, asymptotes, directrix, axis, latus rectum. |
| `SEQ` | 11.1–11.4 | Arithmetic and geometric sequences (from a1 & d/r or two terms), a_n, S_n, infinite sum, which term, repeating decimal to fraction, terms & sum of any a_n, recursive sequences, induction formula check. |
| `COUNT` | 11.5–11.6 | n!, nPr, nCr, binomial expansion, k-th term, term with U^m, Pascal row, letter arrangements (MISSISSIPPI), fundamental counting, circular. |
| `ANGLES` | 4.1 | Degrees and radians (in π form), DMS, coterminal, reference angle, quadrant, complement/supplement, arc length, sector area, linear/angular speed. |
| `TRIGFN` | 4.2–4.4 | Exact values of all six trig functions, point (x, y) on the terminal side, one value + quadrant to the other five, right-triangle solver. |

Each program has a **FORMULAS** menu option.

## Typing tips

- Use the `(-)` key for negative numbers, not the minus key.
- Fractions and roots are fine as input: `9/4`, `2√(2)/3`, `5π/6`.
- For letter answers (like `U=` in the binomial), press `alpha` and then the letter.
- In SEQ, write formulas using `N` (and `P` for the previous term in recursive).

`TRIGFN` switches the calculator to Degree mode.

The `source/` folder has the readable code for every program.
