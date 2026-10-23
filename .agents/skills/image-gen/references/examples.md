# Examples

Copy-paste-ready prompts grouped by use case. All commands use the three supported Cloudflare models.

## Editorial / lifestyle photography

**Model:** Sunburst for finished editorial imagery; Flare for draft composition.

```
Background: a vast rolling emerald meadow stretching toward distant misty mountains at golden hour.
Subject: tall grass and scattered wildflowers swaying in soft breeze.
Details: cinematic medium-format aesthetic, ultra-shallow depth of field, dreamy bokeh, atmospheric haze, painterly pastel clouds.
Lighting: low warm sun raking through grass, soft warm rim light.
Style: Kodak Portra 400 film stock, magazine-quality editorial photo.
Intended use: hero image for a travel publication.
```

```bash
generate_image.py --model openai/gpt-image-2.5-sunburst --prompt "$PROMPT" --output ./out.png \
  --size 1536x1024 --quality high
```

## Photorealistic portrait

```
Background: weathered wooden fishing boat at a quiet coastal dock, soft morning fog.
Subject: an elderly sailor in a wool sweater patching a net.
Details: weathered skin with visible texture, faded traditional tattoos, calm focused expression, a small dog dozing nearby.
Composition: eye-level 50mm lens, three-quarter framing, shallow depth of field.
Lighting: soft coastal daylight, subtle film grain.
Style: candid 35mm film photograph, unposed and honest.
Intended use: editorial profile feature.
```

## Children's book illustration

```
Background: a sun-dappled forest clearing with mushrooms and ferns.
Subject: a young hooded forest hero in a green tunic and brown boots, kind brave expression.
Details: whimsical proportions suitable for a picture book, soft outlines, warm earthy palette.
Style: watercolor children's book illustration, hand-painted, soft natural light.
Intended use: chapter opener for a middle-grade fantasy.
```

## Brand product mockup

**Model:** Sunburst for clean studio output and detailed labels.

```
Background: seamless white studio backdrop with subtle gradient.
Subject: a matte black travel mug with brushed steel lid.
Details: minimal branding, clean silhouette, premium hero-shot framing.
Composition: 45-degree shot, centered, slight reflection on glossy floor.
Lighting: three-point softbox setup, soft falloff, no harsh specular highlights.
Style: high-end retail product photography, studio polish.
Intended use: e-commerce hero image.
```

## Reference-image edit

**Model:** Sunburst for high-fidelity edits and reference-image preservation.

```
Preserve the original product shape, label text, camera angle, reflections, and soft window lighting.
Change only the surface and background: place the product on a honed white marble counter in a warm minimalist kitchen.
Keep the output photorealistic and suitable for an e-commerce hero image.
```

```bash
generate_image.py --model openai/gpt-image-2.5-sunburst \
  --input-image ./product.png \
  --prompt "$PROMPT" \
  --output ./product-kitchen.png \
  --size 1536x1024 --quality high
```

For targeted edits, describe the area precisely in the prompt; these Cloudflare model schemas do not include a mask field.

## Infographic with text

**Model:** Sunburst; specify exact typography in the prompt and inspect the result.

```
A clean educational infographic explaining the flow of an automatic espresso machine.
Layout: vertical, flat design, minimal decoration, labeled diagram.
Components, top to bottom with arrows: bean hopper, burr grinder, dosing chamber, water tank, boiler, group head, cup.
Typography: bold sans-serif labels, exact text "1. Beans", "2. Grind", "3. Dose", "4. Heat", "5. Brew".
Palette: warm cream background, espresso brown accents, single muted teal highlight.
Intended use: classroom handout.
```

```bash
generate_image.py --model openai/gpt-image-2.5-sunburst --prompt "$PROMPT" --output ./infographic.png \
  --size 1024x1536 --quality high
```

## Logo

**Model:** Sunburst; verify lettering manually.

```
A modern minimalist logo for a coffee shop called "The Daily Grind".
Composition: circular badge, centered.
Details: stylized coffee bean negative-space mark, clean bold sans-serif font, exact text "The Daily Grind" arched along the bottom of the circle.
Palette: monochrome — black mark on cream background.
Style: clean flat vector illustration, brand-ready.
Intended use: cafe storefront sign and packaging.
```

## Cinematic still

```
Background: rain-slick neon-lit Tokyo back alley at 2am.
Subject: a lone figure in a long coat walking away from camera, holographic signs reflecting in puddles.
Details: steam from vents, cluttered cables, kanji signage glowing pink and cyan.
Composition: low-angle wide shot, 35mm anamorphic lens, 2.39:1 letterbox.
Lighting: neon-soaked, deep shadows, single warm window glow.
Style: cinematic still, teal-and-orange grade, Blade Runner inspired atmosphere.
Intended use: title card.
```

```bash
generate_image.py --prompt "$PROMPT" --output ./tokyo.png \
  --size 1536x1024 --quality high
```

## Concept art

```
Background: a vast canyon with floating monoliths and bioluminescent flora at dusk.
Subject: a small expedition airship anchored to one of the monoliths.
Details: ornate brass rigging, silk envelope, scale dwarfed by the canyon.
Composition: wide establishing shot, deep aerial perspective.
Lighting: violet dusk sky transitioning to teal, glowing flora as accent light.
Style: matte painting, digital concept art, painterly brushwork.
Intended use: pitch deck key art.
```

## Anime character sheet

```
Background: plain neutral grey backdrop.
Subject: original character in a long crimson coat with gold embroidery, silver hair tied back, calm intense expression.
Composition: full-body three-quarter front view, character sheet style.
Style: highly detailed anime illustration, masterpiece, best quality, cinematic seinen atmosphere, painterly shading.
Intended use: reference sheet for a graphic novel.
```

## Iteration tip

When developing a new shot, start cheap and converge:

```bash
# 1. Cheap drafts to lock composition (~$0.01 each)
generate_image.py --prompt "$PROMPT" --output ./draft1.png --size 1024x1024 --quality low

# 2. Final at high quality once composition is right
generate_image.py --prompt "$PROMPT" --output ./final.png --size 1536x1024 --quality high
```

For top-quality finals, run Sunburst with `--quality max`; it uses more output tokens than `high`.
