export const APP_NO_ROUTE = 'No model is set up yet. Open Settings (the gear in the sidebar), then paste your own Anthropic or OpenAI key, or a Vercel AI Gateway or OpenRouter key, or choose a model running on this computer. Nothing was sent.';
export const TERMINAL_NO_ROUTE = 'No model is set up yet. Use backbone engine codex, then backbone model codex --model <id>; or backbone engine pi, then backbone model local --endpoint <loopback-url> --model <id>. For a hosted API key, paste your own key in the app Settings > AI and models. Nothing was sent.';
export const terminalModelHint = (detail: string): string => detail === APP_NO_ROUTE ? TERMINAL_NO_ROUTE : detail;
/** Where in Settings the no-route hint is shown: the person is already there, so the wording points at the control, not at Settings. */
export const SETTINGS_NO_ROUTE = {
  own: 'No model is set up yet. Under Change your model below, paste your own Anthropic or OpenAI key, or a Vercel AI Gateway or OpenRouter key, or choose a model running on this computer. Nothing was sent.',
  shared: 'No model is set up yet. Under Configure shared work below, paste your own Anthropic or OpenAI key, or a Vercel AI Gateway or OpenRouter key, or choose a model running on this computer. Nothing was sent.',
} as const;
export const settingsModelHint = (detail: string, place: keyof typeof SETTINGS_NO_ROUTE): string => detail === APP_NO_ROUTE ? SETTINGS_NO_ROUTE[place] : detail;
