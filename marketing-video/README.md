# Baby Menu marketing video

This folder contains the HyperFrames source for the Baby Menu README hero video and the committed marketing assets generated from it.

## Outputs

- `baby-menu-marketing.mp4` - rendered source video.
- `baby-menu-marketing-square.gif` - 960x960 README hero GIF at 10fps.

## Workflow

Run commands from the repository root with `pnpm --dir marketing-video <script>`.

```sh
pnpm --dir marketing-video dev
pnpm --dir marketing-video check
pnpm --dir marketing-video render
```

`dev` opens the HyperFrames preview, `check` runs lint / validate / inspect, and `render` produces the MP4.
After rendering, regenerate `baby-menu-marketing-square.gif` from the MP4 before updating the README hero asset.

## Composition Notes

Frame 0 is the settled outro with the logo, `what would yours look like?` tagline, and Homebrew install command, so the first frame works as the X thumbnail and the ending loops cleanly back to the start.
See [DESIGN.md](DESIGN.md#what-this-video-shows) for the story sequence.
