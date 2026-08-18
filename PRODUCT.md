# Product

## Register

product

## Users

Software engineers and technical leads coordinating several local or remote coding-agent and shell sessions. They work in dense desktop environments, often for long stretches, and need to understand state, move between tasks, and reuse operational commands without leaving the terminal.

## Product Purpose

OpenUI is a native command center for concurrent coding agents and terminal sessions. It combines an infinite canvas for system-level coordination with a focused terminal workbench for command execution. Success means users can supervise multiple agents, inspect evidence, and perform repeatable terminal workflows faster while preserving shell correctness and explicit safety boundaries.

## Brand Personality

Operational, restrained, and trustworthy. The interface should feel native to expert developer tools: compact, calm under load, and clear about consequential actions.

## Anti-references

Avoid generic automation dashboards, decorative AI gradients, card-heavy SaaS layouts, terminal cosplay, and visual clones of Warp. Do not hide risky or multi-session state behind transient toasts. Do not replace familiar shell behavior with guessed abstractions.

## Design Principles

1. Preserve terminal truth: the shell, PTY, and tracked lifecycle remain authoritative.
2. Make scope and state persistent: users should see what will be affected before they act.
3. Keep expert workflows in context: libraries, search, and editors belong beside the active terminal rather than in disconnected settings screens.
4. Use progressive disclosure: show the next useful control first and reveal rare configuration only when requested.
5. Earn density: compact presentation is valuable when hierarchy, keyboard access, and recovery remain clear.

## Accessibility & Inclusion

Target keyboard-complete operation, visible focus, meaningful screen-reader names and states, reduced-motion support, non-color status cues, and WCAG AA contrast for product controls. Terminal rendering remains user-configurable and must not be obscured by transient UI.
