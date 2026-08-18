import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { useStore } from "../stores/useStore";
import { highlightCodeBlock } from "./diff/useHighlighter";
import { normalizeWebUrl } from "../utils/webLinks";

interface HighlightedMarkdownProps {
  text: string;
  className?: string;
  onOpenLink?: (url: string) => void;
}

function renderMarkdown(text: string): string {
  const rendered = marked.parse(text, { async: false, gfm: true }) as string;
  return DOMPurify.sanitize(rendered, { ADD_ATTR: ["target"] });
}

export function HighlightedMarkdown({ text, className = "", onOpenLink }: HighlightedMarkdownProps) {
  const codeTheme = useStore((state) => state.diffTheme);
  const baseHtml = useMemo(() => renderMarkdown(text), [text]);
  const [html, setHtml] = useState(baseHtml);

  useEffect(() => {
    let cancelled = false;
    setHtml(baseHtml);

    const documentFragment = new DOMParser().parseFromString(baseHtml, "text/html");
    const codeBlocks = Array.from(documentFragment.querySelectorAll("pre > code"));
    if (codeBlocks.length === 0) return () => {
      cancelled = true;
    };

    Promise.all(
      codeBlocks.map(async (codeElement) => {
        const language = Array.from(codeElement.classList)
          .find((className) => className.startsWith("language-"))
          ?.slice("language-".length);
        if (!language) return;

        const highlighted = await highlightCodeBlock(
          codeElement.textContent ?? "",
          language,
          codeTheme
        );
        if (!highlighted) return;

        const highlightedDocument = new DOMParser().parseFromString(highlighted, "text/html");
        const highlightedPre = highlightedDocument.querySelector("pre");
        const currentPre = codeElement.parentElement;
        if (highlightedPre && currentPre) currentPre.replaceWith(highlightedPre);
      })
    ).then(() => {
      if (cancelled) return;
      setHtml(
        DOMPurify.sanitize(documentFragment.body.innerHTML, {
          ADD_ATTR: ["target", "style", "tabindex"],
        })
      );
    });

    return () => {
      cancelled = true;
    };
  }, [baseHtml, codeTheme]);

  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!onOpenLink) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest("a[href]");
    if (!(anchor instanceof HTMLAnchorElement)) return;
    const url = normalizeWebUrl(anchor.href);
    if (!url) return;
    event.preventDefault();
    event.stopPropagation();
    onOpenLink(url);
  };

  return (
    <div
      className={`markdown-body ${className}`.trim()}
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
