# Lume icon

Source: `lume-icon.png`, generated using the built-in ImageGen tool.

The blue ribbon of light suggests a flame and the letter L. The transparent
outer margin preserves rounded corners on the desktop.

## Generation prompt

Use case: logo-brand. Asset type: production desktop app icon for Lume, a clean modern manager of AI coding sessions. Create one polished minimal icon: a bold sculptural ribbon of light forming an abstract lowercase flame and subtle L silhouette, electric blue #0a84ff with pale cyan illuminated inner edge, centered on a deep midnight navy rounded-square tile. Calm sophisticated desktop software aesthetic, restrained smooth gradients, crisp silhouette, generous thick shapes readable at 16px. Straight-on orthographic view, square canvas, tile fills 88% of canvas with evenly rounded corners and equal margins. Background outside tile truly transparent. One unified symbol only. No letters, no words, no text, no watermark, no extra sparkles, no mockup, no external drop shadow. Deliver a single square high-resolution icon.

## Regenerate platform files

Run `npm run tauri -- icon assets/branding/lume-icon.png --output tmp/lume-icons`,
then copy the desktop files matching the existing filenames into `src-tauri/icons/`.
The Tauri bundle configuration already references these filenames.
