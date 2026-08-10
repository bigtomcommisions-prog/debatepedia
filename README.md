# Debatepedia

A decentralised folder structure for the original Debatepedia single-file prototype.

## Structure

```text
Debatepedia/
├── index.html          # Page markup and script/style includes
├── css/
│   └── main.css        # All original styles
├── js/
│   ├── data.js         # Seed notes and demo submissions
│   └── app.js          # Application logic and UI behaviour
├── data/               # Reserved for future JSON/data files
└── assets/             # Reserved for images/local assets
```

## Run locally

Because the prototype uses browser storage, it can be opened through a static server. From this directory:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`.

## GitHub Pages

This structure is compatible with GitHub Pages because it is still a fully static site. Push the contents of this directory to the repository and configure GitHub Pages to publish from the repository root (or the chosen Pages directory).

## Important

The functionality has intentionally not been redesigned in this step. The original UI, browser-storage behaviour, graph, community submission flow, FOL checker, and seed content have been preserved; the code is simply separated into maintainable files.
