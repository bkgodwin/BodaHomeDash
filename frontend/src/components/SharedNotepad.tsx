import { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { api, jsonBody } from "../api";
import { onScreenKeyboardEnabled } from "../inputPreferences";
import { TouchKeyboard } from "./TouchKeyboard";

interface Props {
  onToast: (message: string) => void;
}

export function SharedNotepad({ onToast }: Props) {
  const [content, setContent] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api<{ content_html: string; updated_at: string | null }>("/notepad")
      .then((value) => {
        setContent(value.content_html || "");
        setSavedAt(value.updated_at);
        setLoaded(true);
      })
      .catch((error) => onToast(error.message));
    const externalUpdate = () => {
      if (document.activeElement === textarea.current || saving) return;
      api<{ content_html: string; updated_at: string | null }>("/notepad")
        .then((value) => {
          setContent(value.content_html || "");
          setSavedAt(value.updated_at);
        })
        .catch(() => undefined);
    };
    window.addEventListener("dashboard:notepad-updated", externalUpdate);
    return () =>
      window.removeEventListener("dashboard:notepad-updated", externalUpdate);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    setSaving(true);
    const timer = window.setTimeout(async () => {
      try {
        const result = await api<{ updated_at: string }>("/notepad", {
          method: "PUT",
          ...jsonBody({ content_html: content })
        });
        setSavedAt(result.updated_at);
      } catch (error: any) {
        onToast(`Notepad could not save: ${error.message}`);
      } finally {
        setSaving(false);
      }
    }, 650);
    return () => window.clearTimeout(timer);
  }, [content, loaded]);

  const replaceSelection = (
    prefix: string,
    suffix = prefix,
    placeholder = "text"
  ) => {
    const input = textarea.current;
    if (!input) return;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const selected = content.slice(start, end) || placeholder;
    const next =
      content.slice(0, start) +
      prefix +
      selected +
      suffix +
      content.slice(end);
    setContent(next);
    window.requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(
        start + prefix.length,
        start + prefix.length + selected.length
      );
    });
  };

  const prefixLine = (prefix: string) => {
    const input = textarea.current;
    if (!input) return;
    const lineStart = content.lastIndexOf("\n", input.selectionStart - 1) + 1;
    setContent(content.slice(0, lineStart) + prefix + content.slice(lineStart));
    window.requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(
        input.selectionStart + prefix.length,
        input.selectionStart + prefix.length
      );
    });
  };

  return (
    <div class="shared-notepad">
      <header class="notepad-toolbar">
        <div>
          <button title="Bold" onClick={() => replaceSelection("**")}>
            <b>B</b>
          </button>
          <button title="Italic" onClick={() => replaceSelection("*")}>
            <i>I</i>
          </button>
          <button title="Underline" onClick={() => replaceSelection("__")}>
            <u>U</u>
          </button>
          <button title="Heading" onClick={() => prefixLine("## ")}>
            H
          </button>
          <button title="Bullet list" onClick={() => prefixLine("- ")}>
            • List
          </button>
          <button title="Checklist" onClick={() => prefixLine("- [ ] ")}>
            ☐ List
          </button>
        </div>
        <button
          class={preview ? "active" : ""}
          onClick={() => {
            setPreview(!preview);
            setKeyboardOpen(false);
          }}
        >
          {preview ? "Edit" : "Preview"}
        </button>
      </header>
      {preview ? (
        <div class="notepad-preview">
          <MarkdownPreview content={content} />
        </div>
      ) : (
        <>
          <textarea
            ref={textarea}
            value={content}
            placeholder="Household notes…"
            onFocus={() => {
              if (onScreenKeyboardEnabled.value) setKeyboardOpen(true);
            }}
            onInput={(event) => setContent(event.currentTarget.value)}
          />
          {keyboardOpen && onScreenKeyboardEnabled.value && (
            <TouchKeyboard
              value={content}
              onChange={setContent}
              targetRef={textarea}
              compact
              onConfirm={() => setKeyboardOpen(false)}
            />
          )}
        </>
      )}
      <footer>
        {saving
          ? "Saving…"
          : savedAt
            ? `Saved ${new Date(savedAt).toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit"
              })}`
            : "Not saved yet"}
      </footer>
    </div>
  );
}

function inlineMarkdown(value: string): ComponentChildren[] {
  return value
    .split(/(\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*)/g)
    .filter(Boolean)
    .map((part) => {
      if (part.startsWith("**") && part.endsWith("**")) {
        return <strong>{part.slice(2, -2)}</strong>;
      }
      if (part.startsWith("__") && part.endsWith("__")) {
        return <u>{part.slice(2, -2)}</u>;
      }
      if (part.startsWith("*") && part.endsWith("*")) {
        return <em>{part.slice(1, -1)}</em>;
      }
      return part;
    });
}

function MarkdownPreview({ content }: { content: string }) {
  const lines = content.split("\n");
  return (
    <>
      {lines.map((line) => {
        if (line.startsWith("## ")) return <h2>{inlineMarkdown(line.slice(3))}</h2>;
        if (line.startsWith("# ")) return <h1>{inlineMarkdown(line.slice(2))}</h1>;
        const checklist = line.match(/^- \[([ xX])\] (.*)$/);
        if (checklist) {
          return (
            <label class="notepad-checkline">
              <input type="checkbox" checked={checklist[1] !== " "} disabled />
              <span>{inlineMarkdown(checklist[2])}</span>
            </label>
          );
        }
        if (line.startsWith("- ")) {
          return <div class="notepad-bullet">• {inlineMarkdown(line.slice(2))}</div>;
        }
        return line ? <p>{inlineMarkdown(line)}</p> : <br />;
      })}
    </>
  );
}
