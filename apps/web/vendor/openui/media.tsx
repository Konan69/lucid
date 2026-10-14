import { defineComponent } from "@openuidev/react-lang";
import { ImageIcon } from "lucide-react";
import { useState } from "react";
import { z } from "zod/v4";
import { Glyph } from "./glyph";
import { color, cx, fg, radius, radiusSchema, webUrl } from "./style";

const ICON_SIZE = { sm: 14, md: 18, lg: 24, xl: 32 } as const;

export const Icon = defineComponent({
  name: "Icon",
  props: z.object({
    name: z.string(),
    size: z.enum(["sm", "md", "lg", "xl"]).optional(),
    color: color.optional(),
  }),
  description: 'Lucide icon by name, e.g. "map-pin".',
  component: ({ props }) => (
    <span className="iui-icon" style={{ color: fg(props.color) }}>
      <Glyph name={props.name} size={ICON_SIZE[props.size ?? "md"] ?? 18} />
    </span>
  ),
});

type PhotoProps = { query: string; src?: string | null; aspectRatio?: number | null; radius?: unknown; fit?: string | null; width?: number | null };

/** A photo from src. Vivid has no photo search, so one that fails to load leaves the empty frame. */
function Photo(props: PhotoProps) {
  const alt = typeof props.query === "string" ? props.query.trim() : "";
  const src = webUrl(props.src);
  const [failed, setFailed] = useState<string[]>([]);
  const [loaded, setLoaded] = useState<string | null>(null);
  const current = src && !failed.includes(src) ? src : undefined;
  const settled = !current;
  const ratio = typeof props.aspectRatio === "number" && props.aspectRatio > 0.2 && props.aspectRatio < 5 ? props.aspectRatio : 1.5;
  return (
    <div
      className={cx("iui-image", props.fit === "contain" && "is-contain", loaded === current && "is-loaded")}
      style={{ aspectRatio: ratio, borderRadius: radius(props.radius ?? "lg"), width: typeof props.width === "number" ? props.width : undefined, flex: typeof props.width === "number" ? "none" : undefined }}
      role={current ? undefined : "img"}
      aria-label={current ? undefined : alt}
    >
      {current ? (
        <img
          key={current}
          src={current}
          alt={alt}
          loading="lazy"
          referrerPolicy="no-referrer"
          ref={(img) => {
            if (img?.complete && img.naturalWidth > 0 && loaded !== current) setLoaded(current);
          }}
          onLoad={() => setLoaded(current)}
          onError={() => setFailed((list) => [...list, current])}
        />
      ) : settled ? (
        <ImageIcon aria-hidden className="iui-image-empty" strokeWidth={1.5} />
      ) : null}
    </div>
  );
}

const fit = z.enum(["cover", "contain"]).optional();

export const Image = defineComponent({
  name: "Image",
  props: z.object({ src: z.string(), alt: z.string(), aspectRatio: z.number().optional(), radius: radiusSchema.optional(), fit, width: z.number().optional() }),
  description: "Photo from an http(s) URL the user or a tool gave. alt says what it shows.",
  component: ({ props }) => <Photo query={props.alt} src={props.src} aspectRatio={props.aspectRatio} radius={props.radius} fit={props.fit} width={props.width} />,
});
