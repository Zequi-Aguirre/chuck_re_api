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
import { OnboardingPromptView } from "../types";

/**
 * Onboarding Ask settings (JAK-first-text-welcome). Any logged-in admin can tune
 * the wording of the DELAYED email ask — the message Jake sends once, right after
 * a customer's 3rd report, inviting them to share a name + email so the full
 * report can be emailed to them. The GoTextJake.com footer is appended by the
 * server regardless, so it can't be edited away. Mobile-first, like the other
 * settings pages (single-column stacking, full-width controls on small screens).
 */
export function OnboardingSettingsPage() {
  const [view, setView] = useState<OnboardingPromptView | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const v = await api.getOnboardingPrompt();
      setView(v);
      setDraft(v.prompt);
    } catch {
      setError("Couldn't load the onboarding ask.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const dirty = view !== null && draft.trim() !== view.prompt.trim();

  async function save() {
    if (!draft.trim()) {
      setError("The onboarding ask can't be empty.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const v = await api.updateOnboardingPrompt(draft);
      setView(v);
      setDraft(v.prompt);
      setToast("Saved. The next customer to hit their 3rd report gets this wording.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save the onboarding ask.");
    } finally {
      setSaving(false);
    }
  }

  async function resetToDefault() {
    setError(null);
    setResetting(true);
    try {
      const v = await api.resetOnboardingPrompt();
      setView(v);
      setDraft(v.prompt);
      setToast("Onboarding ask reset to the default.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reset the onboarding ask.");
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
          Onboarding Ask
        </Typography>
        {view?.isDefault === false && <Chip size="small" color="primary" label="Customized" />}
        {view?.isDefault && <Chip size="small" variant="outlined" label="Default" />}
      </Box>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Jake sends this <strong>once</strong>, right after a customer's 3rd property report, to
        ask for their name and email so the full report can be emailed to them. It never repeats,
        and it's skipped for anyone who's already shared their info.
      </Typography>

      <Alert severity="info" sx={{ mb: 2 }}>
        <AlertTitle>Always enforced automatically</AlertTitle>
        No matter what you write here, Jake stays emoji-free and always ends with the
        GoTextJake.com footer. Sharing info is optional for the customer — this only asks.
      </Alert>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
        <TextField
          label="Onboarding email ask"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          multiline
          minRows={4}
          fullWidth
          disabled={saving || resetting}
          placeholder="Ask the customer for their name and email…"
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
