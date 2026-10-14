/**
 * Workflow templates: `{{ inputs.… }}` and `{{ steps.… }}` inside prompt text, `env` values and,
 * later, `with` values. Any other `{{ … }}` is plain text, so prompts about GitHub Actions or Jinja stay as written.
 */
import { parseExpression, resolvePath, type ExpressionContext, type ExpressionPath } from './expression.js';

/** One `{{ path }}` and where it sits in the source text. */
export interface TemplateRead {
  /** The whole `{{ … }}` as written. */
  source: string;
  path: ExpressionPath;
}

/** Literal text and reads, in source order. */
export type Template = Array<string | TemplateRead>;

/** A recognized template that is not one path: the `{{ … }}` as written and why. */
export interface TemplateError {
  source: string;
  message: string;
}

export type TemplateParse = { ok: true; template: Template } | { ok: false; errors: TemplateError[] };

/** A `{{ … }}` whose content starts with `inputs.` or `steps.`. */
const RECOGNIZED = /\{\{\s*((?:inputs|steps)\.[^{}]*?)\s*\}\}/g;

/** The first template in `text` as written, if any; used to reject one where text is never rendered, such as `command`. */
export function findTemplate(text: string): string | undefined {
  return new RegExp(RECOGNIZED.source).exec(text)?.[0];
}

/** Splits `text` into literal text and reads. Every recognized template must be exactly one path. */
export function parseTemplate(text: string): TemplateParse {
  const template: Template = [];
  const errors: TemplateError[] = [];
  let index = 0;
  for (const match of text.matchAll(RECOGNIZED)) {
    const source = match[0];
    const parsed = parseExpression(match[1] ?? '');
    if (!parsed.ok) {
      errors.push({ source, message: parsed.message });
    } else if (parsed.expression.kind !== 'path') {
      errors.push({ source, message: 'a template reads one path' });
    } else {
      if (match.index > index) template.push(text.slice(index, match.index));
      template.push({ source, path: parsed.expression.path });
    }
    index = match.index + source.length;
  }
  if (errors.length > 0) return { ok: false, errors };
  if (index < text.length) template.push(text.slice(index));
  return { ok: true, template };
}

/** Every path a template reads, in source order. */
export function templatePaths(template: Template): ExpressionPath[] {
  return template.flatMap((part) => (typeof part === 'string' ? [] : [part.path]));
}

/** A value as text: strings as they are, numbers and booleans as text, objects and arrays as JSON, null as ''. */
export function textOf(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Renders a template to text. A missing path renders as ''. */
export function renderText(template: Template, context: ExpressionContext): string {
  return template.map((part) => (typeof part === 'string' ? part : textOf(resolvePath(part.path, context)))).join('');
}

/** Renders a whole value: a template that is exactly one `{{ path }}` keeps the JSON value it reads; anything else is text. */
export function renderValue(template: Template, context: ExpressionContext): unknown {
  const only = template.length === 1 ? template[0] : undefined;
  if (only !== undefined && typeof only !== 'string') return resolvePath(only.path, context);
  return renderText(template, context);
}
