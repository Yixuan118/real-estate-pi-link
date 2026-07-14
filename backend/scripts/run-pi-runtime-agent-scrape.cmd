@echo off
chcp 65001 >nul
codex --no-context-files -p "Read .claude/skills/firecrawl-real-estate-scraper/SKILL.md and use its workflow. Your task: validate, normalize, and rank properties (data via stdin). Coordinate subagents: CriterionEvaluator, Ranker, ReporterAgent. Return JSON only."
