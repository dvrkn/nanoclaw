/**
 * AGENTS.md spec for codex agent groups — codex-owned payload data.
 *
 * AGENTS.md is Codex's project doc (its CLAUDE.md equivalent). Composing it is
 * not codex-specific and lives on trunk in `src/project-doc-compose.ts`, shared
 * with every other provider. What stays here is only what differs: the file
 * name, the runtime-contract base document, two pointer blocks, and Codex's
 * project-doc byte cap.
 *
 * `project_doc_max_bytes` is mirrored in the container provider's config.toml
 * writer. Over the cap the shared composer degrades — it drops the largest
 * capability sections, logs what went, and says so in the document — rather
 * than throwing, which would ride `wakeContainer`'s retry contract and dark
 * the group.
 */
import path from 'path';

import { composeGroupProjectDoc, type ProjectDocSpec } from '../project-doc-compose.js';
import type { AgentGroup } from '../types.js';

export const CODEX_PROJECT_DOC_MAX_BYTES = 32 * 1024;

const MEMORY_POINTER = [
  'The live memory index and definition are supplied by NanoClaw at session startup, clear, and after compaction.',
  'Editable memory-system definition: `/workspace/agent/memory/system/definition.md`.',
  'Top memory index: `/workspace/agent/memory/index.md`.',
  'Read the definition and index, then use linked memory files and conversation archives when relevant.',
  'Stored user preferences are binding: read any linked memory file relevant to the user or the request, and apply it without being asked.',
  'Do not use `AGENTS.local.md` or `AGENTS.override.md` for memory.',
].join('\n\n');

const NATIVE_RUNTIME_SKILLS_POINTER = [
  'Selected NanoClaw runtime skills are available as Codex-native skills at `/workspace/agent/.agents/skills`.',
  'Each skill directory contains a `SKILL.md` with its trigger description plus any supporting files, and points to the read-only shared skill source under `/app/skills`.',
  'Use skill discovery to load these skills only when their descriptions match the task. A skill whose rules must hold before the task is recognised ships an `instructions.md` instead, and those arrive inlined as `NanoClaw Skill:` sections of this document.',
  'Skills YOU author or install yourself go in `~/.codex/skills/<name>/SKILL.md` — persistent across sessions and discovered by Codex automatically. Never write skills elsewhere: paths outside `~/.codex` and `~/.agents` are ephemeral or not discovered.',
].join('\n\n');

const CODEX_PROJECT_DOC: ProjectDocSpec = {
  fileName: 'AGENTS.md',
  baseDocPath: path.join('container', 'AGENTS.md'),
  extraSections: [
    { name: 'Memory System', body: MEMORY_POINTER },
    { name: 'Native Runtime Skills', body: NATIVE_RUNTIME_SKILLS_POINTER },
  ],
  maxBytes: CODEX_PROJECT_DOC_MAX_BYTES,
};

export function composeGroupAgentsMd(group: AgentGroup, groupDir: string): Promise<void> {
  return composeGroupProjectDoc(group, groupDir, CODEX_PROJECT_DOC);
}
