# colormaps — GENERATED, do not hand-edit

This directory is a **generated artifact** of `tools/colormaps` (the Python
atlas baker). The charts fetch it at runtime as `/colormaps/...`
(`colormaps.png` + `colormaps.json` per library, plus `libs.json` and
`schema.json`).

**Do not edit these files by hand.** To change a colormap:

1. Edit the manifests in `tools/colormaps/` (`colormaps.toml` for the `default`
   library, `libraries/<name>.toml` for each other library).
2. Regenerate + sync: `tools/colormaps/sync-to-frontend.sh`
   (rebuilds the atlas and mirrors `tools/colormaps/dist/` into this directory).
   Requires Python ≥3.11 with the tool installed (see that script's header).
3. Commit the regenerated files here.

Source of truth: `tools/colormaps/`. This copy exists only so the packaged app
can serve the atlas over `app://` without a Python runtime.
