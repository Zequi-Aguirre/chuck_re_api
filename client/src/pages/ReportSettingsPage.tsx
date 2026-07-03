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
import { ReportPromptView } from "../types";

/**
 * AI Prompt / Report Settings (JAK-131). Any logged-in admin can tune the
 * STYLE/FORMAT prompt the LLM uses to write the "Jake Property Report" SMS. The
 * HARD guardrails (no emojis, only-provided data, the GoTextJake.com footer) are
 * enforced by the server no matter what is typed here — surfaced as a note so the
 * operator knows they can't be removed.
 */
export function ReportSettingsPage() {
  const [view, setView] = useState<ReportPromptView | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const v = await api.getReportPrompt();
      setView(v);
      setDraft(v.prompt);
    } catch {
      setError("Couldn't load the AI prompt.");
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
      const v = await api.updateReportPrompt(draft);
      setView(v);
      setDraft(v.prompt);
      setToast("Prompt saved. New reports use it right away.");
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
      const v = await api.resetReportPrompt();
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
          AI Prompt
        </Typography>
        {view?.isDefault === false && <Chip size="small" color="primary" label="Customized" />}
        {view?.isDefault && <Chip size="small" variant="outlined" label="Default" />}
      </Box>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        This controls the <strong>style and format</strong> of the "Jake Property Report" text —
        the layout, tone, and which sections to show. Edit it to change how reports read.
      </Typography>

      <Alert severity="info" sx={{ mb: 2 }}>
        <AlertTitle>Always enforced automatically</AlertTitle>
        No matter what you write here, Jake will never use emojis, will use only the verified
        property data (never inventing values), and always ends every report with
        “Get more property info / GoTextJake.com”. These rules can’t be edited away.
      </Alert>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <ModelPickerSection
        load={api.getReportModel}
        save={api.updateReportModel}
        reset={api.resetReportModel}
        onToast={setToast}
        onError={setError}
      />

      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
        <TextField
          label="Report style prompt"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          multiline
          minRows={12}
          fullWidth
          disabled={saving || resetting}
          placeholder="Describe how the property report should look and read…"
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
