import { useCallback, useEffect, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import Paper from "@mui/material/Paper";
import TextField from "@mui/material/TextField";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Snackbar from "@mui/material/Snackbar";
import Stack from "@mui/material/Stack";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import SaveIcon from "@mui/icons-material/Save";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import { api, ApiError } from "../api";
import { ModelPickerSection } from "../components/ModelPickerSection";
import { OrchestratorPromptView } from "../types";

/**
 * Router Prompt Settings (JAK-135). Any logged-in admin can tune the
 * STYLE/CLASSIFICATION prompt the orchestrator uses to read intent from every
 * inbound text and route it to the right specialist. The HARD routing rules
 * (fixed intent set, JSON-only output, never inventing an address) are appended
 * by the server no matter what is typed here — surfaced as a note so the operator
 * knows an edit here can never break routing.
 */
export function OrchestratorSettingsPage() {
  const [view, setView] = useState<OrchestratorPromptView | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const v = await api.getOrchestratorPrompt();
      setView(v);
      setDraft(v.prompt);
    } catch {
      setError("Couldn't load the router prompt.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const dirty = view !== null && draft.trim() !== view.prompt.trim();

  async function save() {
    if (!draft.trim()) {
      setError("The prompt can't be empty.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const v = await api.updateOrchestratorPrompt(draft);
      setView(v);
      setDraft(v.prompt);
      setToast("Prompt saved. New messages route with it right away.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save the prompt.");
    } finally {
      setSaving(false);
    }
  }

  async function resetToDefault() {
    setError(null);
    setResetting(true);
    try {
      const v = await api.resetOrchestratorPrompt();
      setView(v);
      setDraft(v.prompt);
      setToast("Prompt reset to the default.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reset the prompt.");
    } finally {
      setResetting(false);
    }
  }

  if (view === null && error === null) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box sx={{ maxWidth: 860 }}>
      <Box sx={{ display: "flex", alignItems: "center", mb: 1 }}>
        <Typography variant="h5" fontWeight={800} sx={{ flexGrow: 1 }}>
          Router Prompt
        </Typography>
        {view?.isDefault === false && <Chip size="small" color="primary" label="Customized" />}
        {view?.isDefault && <Chip size="small" variant="outlined" label="Default" />}
      </Box>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        This controls how Jake <strong>reads intent</strong> from every inbound text — which
        messages mean "pull a property report", "skip-trace the owner", "get comps", or just
        chitchat, and how it resolves references like "the last address". Edit it to tune routing.
      </Typography>

      <Alert severity="info" sx={{ mb: 2 }}>
        <AlertTitle>Always enforced automatically</AlertTitle>
        No matter what you write here, Jake still uses the fixed set of intents, replies with
        JSON only, and never invents an address it wasn't given. These routing rules are appended
        by the server and can’t be edited away.
      </Alert>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <ModelPickerSection
        load={api.getOrchestratorModel}
        save={api.updateOrchestratorModel}
        reset={api.resetOrchestratorModel}
        onToast={setToast}
        onError={setError}
      />

      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
        <TextField
          label="Router prompt"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          multiline
          minRows={12}
          fullWidth
          disabled={saving || resetting}
          placeholder="Describe how Jake should read intent and route messages…"
        />

        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={1.5}
          sx={{ mt: 2, alignItems: { sm: "center" } }}
        >
          <Button
            variant="contained"
            startIcon={<SaveIcon />}
            onClick={save}
            disabled={!dirty || saving || resetting}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
          <Button
            variant="outlined"
            startIcon={<RestartAltIcon />}
            onClick={resetToDefault}
            disabled={saving || resetting || view?.isDefault}
          >
            {resetting ? "Resetting…" : "Reset to default"}
          </Button>
          <Box sx={{ flexGrow: 1 }} />
          {view && !view.isDefault && view.updatedAt && (
            <Typography variant="caption" color="text.secondary">
              Last edited {new Date(view.updatedAt).toLocaleString()}
            </Typography>
          )}
        </Stack>
      </Paper>

      <Snackbar
        open={Boolean(toast)}
        autoHideDuration={4000}
        onClose={() => setToast(null)}
        message={toast ?? ""}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      />
    </Box>
  );
}
