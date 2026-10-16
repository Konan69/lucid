---
name: find-a-place
description: |-
  When the Person wants physical places found or compared near them or in a named area.
metadata:
  provenance: |-
    Adapted from Muse's shipped procedure, read in full at
    `artifacts/night/raw/wesbos-muse/repo/opt/hatch/skills/places-search/SKILL.md`.
    Kept: full-intent queries, one area per search and no place named without a returned result.
    Its map display and photo detection have no Vivid tool and are dropped.
---

Use this for standing places people can visit: restaurants, cafes, bars, hotels, parks, attractions, shops and local services. It is not for itineraries, choosing a city, dated events or directions.

Use `find_tools` to discover a connected search tool and run it with `use_tool`; offer `connect` when none is ready. Put the complete intent in each query in natural language: the category or venue name, the area, the radius and what makes one better, for example the best sushi restaurants in a named city within five miles rather than just sushi. Never invent or guess a location; if the Person said nearby and their area is not known, ask with `ask_person`. One search covers one area, so run a separate search for each city or neighbourhood named and cover each in the answer. For a named venue, include its exact name and enough area to tell it apart. A follow-up such as cheaper or a different cuisine refines the previous search and keeps its other constraints.

Judge the returned set rather than following its order. Set aside results of the wrong category or area, and leave out places marked permanently or temporarily closed unless asked. If the set is weak, retry with the exact venue name, a narrower type or clearer area wording. Use `read_page` on a place's own page for fresher hours, prices and offerings when the search result is thin.

Never name a place that did not come back from a search or a page you read. For a recommendation give two or three, each with a sentence or two on why it fits, after one short framing line; for a broad request offer a few as a starting point and offer to narrow. Put links to the sources in a display in your reply so each claim can be checked, then note that more options exist without listing them.

Do not write directions or turn-by-turn steps, and do not estimate travel times or distances; use only values a source returned. Reserving a table or room is a booking and needs its own Approval.
