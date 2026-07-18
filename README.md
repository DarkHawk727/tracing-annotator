# Tracing Annotator

A shareable, browser-based version of `pdet_fft_denoised_annotation_widget.ipynb`. It loads urodynamic tracing CSVs, FFT-denoises Pdet, marks permission-to-void times, snaps annotations to a local Pdet peak, and exports the same annotation columns as the notebook.

Patient files are processed entirely in the browser. The site does not upload or persist them.

## Run locally

The site uses JavaScript modules, so serve the directory instead of opening `index.html` directly:

```bash
npm run serve
```

Then open <http://localhost:8000>.

Python works too:

```bash
python3 -m http.server 8000
```

## Use the site

1. Add one or more tracing files. Tab-separated `.csv` files like `3514620.csv` and ordinary comma-separated files are both supported. Each filename should contain the MRN.
2. Optionally add a permission-to-void lookup CSV. Both a simple `MRN, Time` file and the supplied wide spreadsheet export are supported.
3. Start the review. Click the chart to add a point, or enter a time manually. As in the notebook, each point snaps to the highest denoised Pdet within ±5 seconds.
4. Select **Export review** to download `tracing_review_export.zip`. It contains `pdet_annotated_points.csv`, sure tracing files in `sure_tracings/`, and unsure/flagged tracing files in `flagged_tracings/`.

The chart supports click-to-annotate, drag-to-pan, scroll-to-zoom, patient navigation, an unsure review queue, manual permission correction, raw-signal visibility, adjustable Y-axis limits, configurable FFT cutoff/transition values, undo, deletion, and clearing a patient's points.

## Publish as a website

This is a static site with no build step. Deploy these files to any static host:

- `index.html`
- `styles.css`
- `app.js`
- `core.js`

For example, they can be hosted with GitHub Pages, Netlify, Cloudflare Pages, or an internal static web server. Because there is no backend, uploaded tracings remain on the user's device.

## Test

```bash
npm test
```

The tests cover both supplied example files and compare the browser FFT output against NumPy output from the original notebook settings.
