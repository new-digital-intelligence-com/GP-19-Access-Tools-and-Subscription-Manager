import React from "react";

/**
 * A small Markdown renderer for the assistant's replies.
 *
 * The model writes Markdown whether or not anyone asked it to — bold labels,
 * bullet lists, the occasional table — and rendering that as plain text puts
 * literal `**asterisks**` in front of the reader, which looks broken and makes
 * a structured answer harder to scan than an unstructured one.
 *
 * Written by hand rather than pulled from npm for one reason that matters:
 * **it builds React elements, never HTML strings.** There is no
 * `dangerouslySetInnerHTML` anywhere below, so model output — which in this app
 * can quote a justification somebody else typed — cannot become markup. A
 * general Markdown library would also bring raw-HTML passthrough, which is
 * exactly the feature this must not have.
 *
 * It covers the subset the model actually produces. Anything unrecognised
 * falls through as text, which is the right failure: a stray character beats a
 * swallowed sentence.
 */

/** `**bold**`, `*italic*`, `` `code` ``, and bare or bracketed links. */
function inline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // One pass, longest-token-first so `**` is never read as two `*`.
  const pattern =
    /(\*\*[^*]+\*\*)|(`[^`]+`)|(\*[^*\n]+\*)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s<>)]+)/g;

  let last = 0;
  let match: RegExpExecArray | null;
  let n = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-i${n++}`;

    if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`")) {
      nodes.push(
        <code
          key={key}
          className="rounded bg-black/[0.06] px-1.5 py-0.5 font-mono text-[0.85em]"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("[")) {
      const split = token.indexOf("](");
      const label = token.slice(1, split);
      const href = token.slice(split + 2, -1);
      nodes.push(
        <a
          key={key}
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="text-brand-ink underline underline-offset-2"
        >
          {label}
        </a>,
      );
    } else if (token.startsWith("http")) {
      nodes.push(
        <a
          key={key}
          href={token}
          target="_blank"
          rel="noreferrer noopener"
          className="break-all text-brand-ink underline underline-offset-2"
        >
          {token}
        </a>,
      );
    } else {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    last = match.index + token.length;
  }

  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const TABLE_DIVIDER = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;

function cells(row: string): string[] {
  return row
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];

  let paragraph: string[] = [];
  let key = 0;

  const flush = () => {
    if (!paragraph.length) return;
    const body = paragraph.join(" ").trim();
    paragraph = [];
    if (body) {
      blocks.push(
        <p key={`p${key++}`} className="leading-relaxed">
          {inline(body, `p${key}`)}
        </p>,
      );
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code: taken verbatim to the closing fence, or to the end if the
    // model never closed it — dropping the rest would lose the answer.
    if (/^\s*```/.test(line)) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      blocks.push(
        <pre
          key={`c${key++}`}
          className="overflow-x-auto rounded-xl bg-black/[0.05] p-3 font-mono text-xs leading-relaxed"
        >
          {body.join("\n")}
        </pre>,
      );
      continue;
    }

    if (!line.trim()) {
      flush();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push(
        <p key={`h${key++}`} className="mt-1 font-semibold">
          {inline(heading[2], `h${key}`)}
        </p>,
      );
      continue;
    }

    // A table needs its divider row to be a table at all; without one these
    // are just lines containing pipes.
    if (line.includes("|") && TABLE_DIVIDER.test(lines[i + 1] ?? "")) {
      flush();
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(cells(lines[i++]));
      }
      i--;
      blocks.push(
        <div key={`t${key++}`} className="overflow-x-auto rounded-xl border border-black/10">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-black/8">
                {head.map((cell, c) => (
                  <th key={c} className="px-3 py-2 font-medium text-black/55">
                    {inline(cell, `th${c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-black/5">
              {rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} className="px-3 py-2 align-top">
                      {inline(cell, `td${r}-${c}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (BULLET.test(line) || NUMBERED.test(line)) {
      flush();
      const ordered = !BULLET.test(line);
      const items: string[] = [];
      while (i < lines.length) {
        const bullet = BULLET.exec(lines[i]);
        const numbered = NUMBERED.exec(lines[i]);
        if (ordered && numbered) items.push(numbered[2]);
        else if (!ordered && bullet) items.push(bullet[1]);
        // A wrapped continuation line belongs to the item above it.
        else if (items.length && /^\s{2,}\S/.test(lines[i])) {
          items[items.length - 1] += ` ${lines[i].trim()}`;
        } else break;
        i++;
      }
      i--;
      const ListTag = ordered ? "ol" : "ul";
      blocks.push(
        <ListTag
          key={`l${key++}`}
          className={`space-y-1 ${ordered ? "list-decimal" : "list-disc"} pl-5 leading-relaxed marker:text-black/35`}
        >
          {items.map((item, n) => (
            <li key={n}>{inline(item, `li${key}-${n}`)}</li>
          ))}
        </ListTag>,
      );
      continue;
    }

    paragraph.push(line.trim());
  }

  flush();
  return <div className="space-y-3 text-sm">{blocks}</div>;
}
