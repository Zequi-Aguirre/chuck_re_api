import { useCallback, useEffect, useMemo, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import Paper from "@mui/material/Paper";
import TextField from "@mui/material/TextField";
import Autocomplete from "@mui/material/Autocomplete";
import Alert from "@mui/material/Alert";
import Stack from "@mui/material/Stack";
import Chip from "@mui/material/Chip";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import Select from "@mui/material/Select";
import MenuItem from "@mui/material/MenuItem";
import SaveIcon from "@mui/icons-material/Save";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import { ApiError } from "../api";
import { LlmModelSettingView, LlmProvider } from "../types";

/** Human labels for the providers. */
const PROVIDER_LABEL: Record<LlmProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
};

/**
 * Common model ids per provider — suggestions ONLY. The field is free-text
 * (freeSolo), so a brand-new model id works without a code change (JAK-143).
 */
const MODEL_OPTIONS: Record<LlmProvider, string[]> = {
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-4.1"],
  anthropic: ["claude-opus-4-8", "claude-sonnet-4-6"],
};

interface ModelPickerSectionProps {
  /** Fetch this surface's current provider+model view. */
  load: () => Promise<LlmModelSettingView>;
  /** Pin a provider + (optional) model for this surface. */
  save: (provider: LlmProvider, model: string) => Promise<LlmModelSettingView>;
  /** Clear the override so the surface inherits the global default. */
  reset: () => Promise<LlmModelSettingView>;
  /** Surface a success message on the parent page's snackbar. */
  onToast: (message: string) => void;
  /** Surface an error message on the parent page's alert. */
  onError: (message: string) => void;
}

/**
 * The per-prompt PROVIDER + MODEL picker (JAK-143) — a reusable section dropped
 * onto each of the four editable-prompt pages (router, skip-trace, comps, property
 * report). It shows a provider dropdown (OpenAI / Anthropic) + a free-text model
 * field with common suggestions, plus the effective global default when nothing is
 * pinned, and a subtle note when the selected provider has no key configured in
 * Doppler (informational — Jake falls back cleanly).
 *
 * There is deliberately NO api-key input anywhere here. This picker only ever
 * SELECTS a provider + model; the keys stay Doppler secrets, never entered or shown.
 */
export function ModelPickerSection({ load, save, reset, onToast, onError }: ModelPickerSectionProps) {
  const [view, setView] = useState<LlmModelSettingView | null>(null);
  const [providerDraft, setProviderDraft] = useState<LlmProvider>("openai");
  const [modelDraft, setModelDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);

  const applyView = useCallback((v: LlmModelSettingView) => {
    setView(v);
    // Seed the editor with the EFFECTIVE selection so the admin sees exactly what
    // the surface runs on right now (whether pinned or inherited from the default).
    setProviderDraft(v.effectiveProvider);
    setModelDraft(v.effectiveModel);
  }, []);

  const loadSection = useCallback(async () => {
    try {
      applyView(await load());
    } catch {
      onError("Couldn't load the model setting.");
    }
  }, [load, applyView, onError]);

  useEffect(() => {
    loadSection();
  }, [loadSection]);

  // Dirty vs. the effective selection currently in force. When inheriting the
  // default, changing either field lets the admin PIN it.
  const dirty =
    view !== null &&
    (providerDraft !== view.effectiveProvider || modelDraft.trim() !== view.effectiveModel);

  const keyConfigured = view?.providerKeyConfigured[providerDraft] ?? true;

  const modelOptions = useMemo(() => MODEL_OPTIONS[providerDraft] ?? [], [providerDraft]);

  function onProviderChange(next: LlmProvider) {
    setProviderDraft(next);
    // Clear the model on a provider switch — a model id belongs to one provider, so
    // carrying it over would pin an incompatible model. Blank = that provider's default.
    setModelDraft("");
  }

  async function save_() {
    setSaving(true);
    try {
      const v = await save(providerDraft, modelDraft.trim());
      applyView(v);
      onToast("Model saved. New messages use it right away.");
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't save the model.");
    } finally {
      setSaving(false);
    }
  }

  async function resetToDefault() {
    setResetting(true);
    try {
      const v = await reset();
      applyView(v);
      onToast("Model reset to the default.");
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Couldn't reset the model.");
    } finally {
      setResetting(false);
    }
  }

  if (view === null) return null;

  return (
    <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 }, mb: 3 }}>
      <Box sx={{ display: "flex", alignItems: "center", mb: 1.5 }}>
        <Typography variant="subtitle1" fontWeight={700} sx={{ flexGrow: 1 }}>
          Provider &amp; model
        </Typography>
        {view.isDefault ? (
          <Chip size="small" variant="outlined" label="Default" />
        ) : (
          <Chip size="small" color="primary" label="Customized" />
        )}
      </Box>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Choose which AI provider and model this prompt runs on. Leave it on the default to
        follow the app-wide setting ({PROVIDER_LABEL[view.defaultProvider]} / {view.defaultModel}).
        API keys are managed in Doppler — there's nothing to enter here.
      </Typography>

      <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ mb: 2 }}>
        {/* Full-width on a phone so the fields never overflow the viewport (JAK-149). */}
        <FormControl sx={{ width: { xs: "100%", sm: 200 } }} disabled={saving || resetting}>
          <InputLabel id="provider-label">Provider</InputLabel>
          <Select
            labelId="provider-label"
            label="Provider"
            value={providerDraft}
            onChange={(e) => onProviderChange(e.target.value as LlmProvider)}
          >
            <MenuItem value="openai">OpenAI</MenuItem>
            <MenuItem value="anthropic">Anthropic</MenuItem>
          </Select>
        </FormControl>

        <Autocomplete
          freeSolo
          options={modelOptions}
          inputValue={modelDraft}
          onInputChange={(_e, value) => setModelDraft(value)}
          disabled={saving || resetting}
          sx={{ width: { xs: "100%", sm: 320 } }}
          renderInput={(params) => (
            <TextField
              {...params}
              label="Model"
              placeholder={`e.g. ${modelOptions[0] ?? ""}`}
              helperText={`Leave blank to use ${PROVIDER_LABEL[providerDraft]}'s default model.`}
            />
          )}
        />
      </Stack>

      {!keyConfigured && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {PROVIDER_LABEL[providerDraft]} key not configured in Doppler — Jake will fall back to a
          deterministic reply for this step until a key is set. (No key is entered here.)
        </Alert>
      )}

      {view.isDefault && (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 2 }}>
          Currently inheriting the default: {PROVIDER_LABEL[view.effectiveProvider]} / {view.effectiveModel}.
        </Typography>
      )}

      <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ alignItems: { sm: "center" } }}>
        <Button
          variant="contained"
          startIcon={<SaveIcon />}
          onClick={save_}
          disabled={!dirty || saving || resetting}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button
          variant="outlined"
          startIcon={<RestartAltIcon />}
          onClick={resetToDefault}
          disabled={saving || resetting || view.isDefault}
        >
          {resetting ? "Resetting…" : "Reset to default"}
        </Button>
        <Box sx={{ flexGrow: 1 }} />
        {!view.isDefault && view.updatedAt && (
          <Typography variant="caption" color="text.secondary">
            Last edited {new Date(view.updatedAt).toLocaleString()}
          </Typography>
        )}
      </Stack>
    </Paper>
  );
}
