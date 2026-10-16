# Prompting

Good prompts are concrete narratives, not bag-of-keywords lists. The supported OpenAI image models on Cloudflare respond well to a director's or photographer's scene brief.

## The order that works

OpenAI's official guide recommends this sequence:

1. **Scene / background** — where we are, what surrounds the subject.
2. **Subject** — the primary focus.
3. **Key details** — materials, textures, proportions, distinguishing features.
4. **Constraints** — what to preserve, exclude, or hold consistent across edits.
5. **Intended use** — "for an ad", "for a UI mock", "for a children's book". This sets the model's "mode" and level of polish.

Then layer in:

- **Composition / framing** — wide shot, macro, low-angle, over-the-shoulder, three-quarter portrait.
- **Lighting / mood** — golden hour, soft diffused, hard noir, rim light, three-point softbox.
- **Visual medium** — photograph, watercolor, 3D render, gouache, oil painting.
- **Style cues** — palette, grain, brushwork, sharpness, era.
- **Typography** — exact text in quotes, font style, placement.

## A reusable template

```
A [SCENE] with [SUBJECT] [doing ACTION].
[KEY DETAILS — 2–4 specific noun phrases].
Composition: [FRAMING + CAMERA].
Lighting: [LIGHT TYPE + MOOD].
Style: [MEDIUM + AESTHETIC + ERA/REFERENCE].
[INTENDED USE — e.g. "for a magazine cover", "as a hero image"].
```

Drop sections you don't need, but keep the order.

## Model notes

- Supported IDs: `openai/gpt-image-2.5-sunburst`, `openai/gpt-image-2.5-flare`, `openai/gpt-image-2`.
- Use straight quotes for literal text, e.g. `labeled "Relax & Unwind"`.
- Sunburst defaults to `--quality high`; choose `--quality max` for the benchmarked top-quality setting when the extra cost is justified. Use Flare to iterate quickly.
- Pass one or more `--input-image` flags for edits. Say exactly what to preserve before saying what to change: “Preserve the product shape, label text, camera angle, and soft window lighting. Change only the background to…”
- These Cloudflare schemas have no mask or negative-prompt field. Describe a localized change precisely in the text prompt.

## Iteration loop

1. Draft with Flare at `--quality low` or `medium`.
2. Regenerate the chosen composition with Sunburst at `high` (default) or `max` (more costly).
3. Keep the prompt beside the output to compare the two models fairly.

## Anti-patterns

- Bag of adjectives with no subject (`"cinematic, moody, atmospheric, beautiful"`) — model has nothing to anchor on.
- Conflicting style cues (`"photorealistic anime watercolor 3D render"`) — the model averages them and you get mush.
- Negative-only prompts (`"no people, no text"`) — these model schemas have no negative-prompt channel; describe what *should* be there instead.
- Over-stuffed single sentences with 30 commas. Break into the template above.
