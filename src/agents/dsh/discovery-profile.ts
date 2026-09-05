export const DISCOVERY_PROFILE = `# DSH-specific Code Mode configuration stays inside this adapter patch.
- id: tools
  config:
    mode: code
    maxParallelSubCalls: 1

- id: llm-pi-ai
  config:
    providers:
      openrouter:
        apiKeyEnv: OPENROUTER_API_KEY
        reasoning: high
        models:
          - id: openai/gpt-5.6-luna:nitro
            name: GPT-5.6 Luna Nitro
            contextWindow: 1000000
            maxTokens: 16384
            reasoningEfforts:
              low: low
              medium: medium
              high: high
            compat:
              thinkingFormat: openrouter
              supportsDeveloperRole: true
              requiresReasoningContentOnAssistantMessages: false
          - id: deepseek/deepseek-v4-pro-0813
            name: DeepSeek V4 Pro 0813
            contextWindow: 1000000
            maxTokens: 16384
            reasoningEfforts:
              low: low
              medium: medium
              high: high
            compat:
              thinkingFormat: openrouter
              supportsDeveloperRole: false
              requiresReasoningContentOnAssistantMessages: true

- id: agent-default-model
  config:
    provider: openrouter
    model: openai/gpt-5.6-luna:nitro

- id: system-prompt
  config:
    persona: |
      You discover a browser automation from a natural-language task.
      After finishDiscovery returns discovered, STOP.

- id: session-persistence-jsonl
  config:
    root: !!js process.env.DSH_POC_SESSION_DIR
    compression: none

- id: session-telemetry-otel
  disabled: true
- id: agent-instructions
  disabled: true
- id: session-title-llm
  disabled: true
- id: plan-mode
  disabled: true
- id: user-questions
  disabled: true
- id: web
  disabled: true
- id: web-search-deepseek
  disabled: true
- id: tool-bash
  disabled: true
- id: tool-pwsh
  disabled: true
- id: tool-jobs
  disabled: true
- id: tool-fs
  disabled: true
- id: tool-fs-search
  disabled: true
- id: tool-skill
  disabled: true
- id: tool-subagent-control
  disabled: true
- id: tool-subagent-list-agents
  disabled: true
- id: tool-subagent
  disabled: true
- id: tool-subagent-fork
  disabled: true
- id: tool-subagent-report
  disabled: true
- id: tool-workflow
  disabled: true
- id: tool-todo
  disabled: true
- id: tool-goal
  disabled: true
- id: tool-ralph
  disabled: true
- id: tool-str-replace-editor
  disabled: true
- id: tool-web
  disabled: true

- insert:
    - id: dsh-discovery-semantic-tools
      name: __DSH_DISCOVERY_PLUGIN__
`;
