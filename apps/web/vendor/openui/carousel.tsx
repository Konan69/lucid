import { defineComponent } from "@openuidev/react-lang";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { z } from "zod/v4";
import { children } from "./style";

// Carousel
export const Carousel = defineComponent({
  name: "Carousel",
  props: z.object({ children, itemWidth: z.number().optional(), gap: z.number().optional() }),
  description: "Horizontal row that scrolls and snaps, each child an item itemWidth px wide (default 240): photos, cards, options, days.",
  component: function CarouselView({ props, renderNode }) {
    const ref = useRef<HTMLDivElement>(null);
    const [edges, setEdges] = useState({ start: true, end: true });
    const items = (Array.isArray(props.children) ? props.children.flat() : []).filter((c) => c != null);
    const width = Math.min(640, Math.max(80, props.itemWidth ?? 240));
    useLayoutEffect(() => {
      const el = ref.current;
      if (!el) return;
      const read = () => setEdges({ start: el.scrollLeft < 4, end: el.scrollLeft + el.clientWidth > el.scrollWidth - 4 });
      read();
      el.addEventListener("scroll", read, { passive: true });
      const observer = new ResizeObserver(read);
      observer.observe(el);
      return () => {
        el.removeEventListener("scroll", read);
        observer.disconnect();
      };
    }, [items.length]);
    const page = (dir: number) => ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.85, behavior: "smooth" });
    return (
      <div className="iui-carousel">
        <div ref={ref} className="iui-carousel-track" style={{ gap: props.gap != null ? Math.max(0, props.gap) * 4 : undefined }}>
          {items.map((item, i) => (
            <div key={i} className="iui-carousel-item" style={{ width }}>
              {renderNode(item)}
            </div>
          ))}
        </div>
        {!edges.start && (
          <button type="button" className="iui-carousel-nav is-prev" aria-label="Previous" onClick={() => page(-1)}>
            <ChevronLeft size={18} />
          </button>
        )}
        {!edges.end && (
          <button type="button" className="iui-carousel-nav is-next" aria-label="Next" onClick={() => page(1)}>
            <ChevronRight size={18} />
          </button>
        )}
      </div>
    );
  },
});
