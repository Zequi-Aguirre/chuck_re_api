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
import { CompsSelectionPromptView } from "../types";

/**
 * Comps Selection Engine Settings (JAK-164). Any logged-in admin can tune the
 * heuristics Jake uses to pick the STRONGEST true comps from the real up-to-10-mile
 * candidate pool — the scoring, reject, distance/recency, and outlier rules. This is
 * the SELECTION step (not the reply formatting, which stays on the Comps page). The
 * JSON-output hard rules and every numeric field (sale price/date used, PPSF, days on
 * market, distance) are enforced by the engine no matter what is typed here — surfaced
 * as a note so the operator knows an edit here can never make a number wrong.
 */
export function CompsSelectionSettingsPage() {
  const [view, setView] = useState<CompsSelectionPromptView | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const v = await api.getCompsSelectionPrompt();
      setView(v);
      setDraft(v.prompt);
    } catch {
      setError("Couldn't load the comps selection prompt.");
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
      const v = await api.updateCompsSelectionPrompt(draft);
      setView(v);
      setDraft(v.prompt);
      setToast("Selection prompt saved. New comps requests use it right away.");
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
      const v = await api.resetCompsSelectionPrompt();
      setView(v);
      setDraft(v.prompt);
      setToast("Selection prompt reset to the default.");
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
          Comps Selection
        </Typography>
        {view?.isDefault === false && <Chip size="small" color="primary" label="Customized" />}
        {view?.isDefault && <Chip size="small" variant="outlined" label="Default" />}
      </Box>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        This controls how Jake <strong>chooses the strongest comps</strong> from the real
        up-to-10-mile candidate pool — the scoring, reject, distance/recency, and outlier rules.
        It runs before the reply is written, so edit it to tune WHICH sales become comps. The
        reply wording itself is on the Comps page.
      </Typography>

      <Alert severity="info" sx={{ mb: 2 }}>
        <AlertTitle>Always enforced automatically</AlertTitle>
        No matter what you write here, Jake only ever picks from the candidates it pulled, returns
        at most 5 comps, and computes every number (sale price and date used, price per square
        foot, days on market, distance) in code — so an edit here can change which comps are chosen
        but can never make a figure wrong or invent a comp.
      </Alert>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <ModelPickerSection
        load={api.getCompsSelectionModel}
        save={api.updateCompsSelectionModel}
        reset={api.resetCompsSelectionModel}
        onToast={setToast}
        onError={setError}
      />

      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
        <TextField
          label="Comps selection prompt"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          multiline
          minRows={12}
          fullWidth
          disabled={saving || resetting}
          placeholder="Describe how Jake should score, reject, and rank comparable sales…"
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
