import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams, Link as RouterLink } from "react-router-dom";
import Box from "@mui/material/Box";
import Grid from "@mui/material/Grid";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Divider from "@mui/material/Divider";
import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Link from "@mui/material/Link";
import Switch from "@mui/material/Switch";
import FormControlLabel from "@mui/material/FormControlLabel";
import useMediaQuery from "@mui/material/useMediaQuery";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import { api } from "../api";
import { LocationStatusDetail } from "../types";
import { StatusChip } from "../components/StatusChip";
import { ConnectionFormDialog } from "../components/ConnectionFormDialog";
import { GrantCreditsDialog } from "../components/GrantCreditsDialog";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ADMIN_MOBILE_QUERY } from "./responsiveLayout";

/**
 * Full per-sub-account view: status, credits, outcomes, failures, and actions.
 *
 * MOBILE-FIRST (JAK-149): the header actions already wrap; below the mobile
 * breakpoint the ledger + activity/failure tables render as CARDS instead of
 * wide tables so the page fits a phone with no horizontal scroll.
 */
export function ConnectionDetailPage() {
  const { locationId = "" } = useParams();
  const navigate = useNavigate();
  const isMobile = useMediaQuery(ADMIN_MOBILE_QUERY);
  const [detail, setDetail] = useState<LocationStatusDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [creditsOpen, setCreditsOpen] = useState(false);
  const [confirm, setConfirm] = useState<null | "deactivate" | "delete">(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setDetail(await api.getConnection(locationId));
    } catch {
      setNotFound(true);
    }
  }, [locationId]);

  useEffect(() => {
    load();
  }, [load]);

  async function runAction(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch {
      setError("Action failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (notFound) {
    return (
      <Box>
        <BackLink />
        <Alert severity="warning" sx={{ mt: 2 }}>
          That sub-account was not found.
        </Alert>
      </Box>
    );
  }

  if (!detail) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  const { connection, credits, enrichment, failures } = detail;
  const isActive = connection.status === "active";

  return (
    <Box>
      <BackLink />

      {error && (
        <Alert severity="error" sx={{ my: 2 }}>
          {error}
        </Alert>
      )}

      {/* Header + actions */}
      <Paper sx={{ p: 3, mt: 2 }}>
        <Box sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 2, mb: 2 }}>
          <Typography variant="h5" fontWeight={800} sx={{ fontFamily: "monospace", flexGrow: 1 }}>
            {connection.locationId}
          </Typography>
          <StatusChip status={connection.status} />
        </Box>

        <Grid container spacing={2} sx={{ mb: 2 }}>
          <Field label="Base URL" value={connection.baseUrl} mono />
          <Field label="Phone numbers" value={String(connection.phoneNumberCount)} />
          <Field label="Provisioned fields" value={String(connection.provisionedFieldCount)} />
          <Field label="Connected" value={new Date(connection.installedAt).toLocaleString()} />
        </Grid>

        <Divider sx={{ my: 2 }} />

        {/* JAK-186 — per-sub-account auto-enrichment toggle. Opt-in: OFF until an
            operator turns it on, so connecting an account never silently starts
            enriching (+ spending) on every new contact. flexWrap keeps the label
            + switch on-screen on a phone. */}
        <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1, mb: 2 }}>
          <Box sx={{ flexGrow: 1, minWidth: 0, pr: 1 }}>
            <Typography variant="subtitle2" fontWeight={700}>
              Auto-enrich new contacts
            </Typography>
            <Typography variant="caption" color="text.secondary">
              When on, a new GHL contact in this sub-account is enriched automatically.
            </Typography>
          </Box>
          <FormControlLabel
            sx={{ flexShrink: 0, m: 0 }}
            labelPlacement="start"
            control={
              <Switch
                checked={connection.autoEnrichmentEnabled}
                disabled={busy}
                onChange={(e) =>
                  runAction(async () => {
                    await api.setAutoEnrichment(connection.locationId, e.target.checked);
                    await load();
                  })
                }
                inputProps={{ "aria-label": "Auto-enrich new contacts" }}
              />
            }
            label={
              <Typography variant="body2" sx={{ mr: 1 }}>
                {connection.autoEnrichmentEnabled ? "On" : "Off"}
              </Typography>
            }
          />
        </Box>

        <Divider sx={{ my: 2 }} />

        <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap>
          <Button variant="outlined" onClick={() => setEditOpen(true)} disabled={busy}>
            Edit / rotate key
          </Button>
          <Button variant="outlined" onClick={() => setCreditsOpen(true)} disabled={busy}>
            Adjust credits
          </Button>
          {isActive ? (
            <Button
              color="warning"
              variant="outlined"
              disabled={busy}
              onClick={() => setConfirm("deactivate")}
            >
              Deactivate
            </Button>
          ) : (
            <Button
              color="success"
              variant="outlined"
              disabled={busy}
              onClick={() => runAction(async () => {
                await api.activate(connection.locationId);
                await load();
              })}
            >
              Activate
            </Button>
          )}
          <Button color="error" variant="outlined" disabled={busy} onClick={() => setConfirm("delete")}>
            Delete
          </Button>
        </Stack>
      </Paper>

      {/* Credits + outcomes */}
      <Grid container spacing={3} sx={{ mt: 0 }}>
        <Grid item xs={12} md={4}>
          <Paper sx={{ p: 3, height: "100%" }}>
            <Typography variant="overline" color="text.secondary">
              Credit balance
            </Typography>
            <Typography variant="h3" fontWeight={800}>
              {credits.balance}
            </Typography>
          </Paper>
        </Grid>
        <Grid item xs={12} md={8}>
          <Paper sx={{ p: 3, height: "100%" }}>
            <Typography variant="overline" color="text.secondary">
              Enrichment outcomes
            </Typography>
            <Grid container spacing={2} sx={{ mt: 0.5 }}>
              <Metric label="Enriched" value={enrichment.counts.enriched} />
              <Metric label="Skipped" value={enrichment.counts.skipped} />
              <Metric label="Credit-blocked" value={enrichment.counts.credit_blocked} />
              <Metric label="Failed" value={enrichment.counts.failed} />
              <Metric label="Dead-letter" value={enrichment.counts.dead_letter} />
              <Metric label="Total" value={enrichment.counts.total} />
            </Grid>
          </Paper>
        </Grid>
      </Grid>

      {/* Failures */}
      <SectionPaper title="Recent failures">
        {failures.length === 0 ? (
          <Empty>No failures — nice.</Empty>
        ) : (
          <EventTable events={failures} isMobile={isMobile} />
        )}
      </SectionPaper>

      {/* Recent enrichment activity */}
      <SectionPaper title="Recent activity">
        {enrichment.recent.length === 0 ? (
          <Empty>No enrichment events yet.</Empty>
        ) : (
          <EventTable events={enrichment.recent} isMobile={isMobile} />
        )}
      </SectionPaper>

      {/* Recent credit ledger */}
      <SectionPaper title="Recent credit ledger">
        {credits.recent.length === 0 ? (
          <Empty>No credit entries yet.</Empty>
        ) : isMobile ? (
          <Stack spacing={1.5}>
            {credits.recent.map((e) => (
              <Card key={e.id} variant="outlined">
                <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
                  <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 1 }}>
                    <Typography variant="body2" sx={{ minWidth: 0, wordBreak: "break-word" }}>
                      {e.reason}
                    </Typography>
                    <Typography
                      variant="subtitle2"
                      sx={{ flexShrink: 0, color: e.amount < 0 ? "error.main" : "success.main" }}
                    >
                      {e.amount > 0 ? `+${e.amount}` : e.amount}
                    </Typography>
                  </Box>
                  <Typography variant="caption" color="text.secondary">
                    {new Date(e.createdAt).toLocaleString()} · balance {e.balanceAfter}
                  </Typography>
                </CardContent>
              </Card>
            ))}
          </Stack>
        ) : (
          <Box sx={{ overflowX: "auto" }}>
          <Table size="small" sx={{ minWidth: 480 }}>
            <TableHead>
              <TableRow>
                <TableCell>When</TableCell>
                <TableCell>Reason</TableCell>
                <TableCell align="right">Amount</TableCell>
                <TableCell align="right">Balance</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {credits.recent.map((e) => (
                <TableRow key={e.id}>
                  <TableCell>{new Date(e.createdAt).toLocaleString()}</TableCell>
                  <TableCell>{e.reason}</TableCell>
                  <TableCell align="right" sx={{ color: e.amount < 0 ? "error.main" : "success.main" }}>
                    {e.amount > 0 ? `+${e.amount}` : e.amount}
                  </TableCell>
                  <TableCell align="right">{e.balanceAfter}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          </Box>
        )}
      </SectionPaper>

      {/* Dialogs */}
      <ConnectionFormDialog
        open={editOpen}
        mode="edit"
        initial={{
          locationId: connection.locationId,
          baseUrl: connection.baseUrl,
          phoneNumbers: [],
        }}
        onClose={() => setEditOpen(false)}
        onSaved={load}
      />
      <GrantCreditsDialog
        open={creditsOpen}
        locationId={connection.locationId}
        onClose={() => setCreditsOpen(false)}
        onSaved={load}
      />
      <ConfirmDialog
        open={confirm === "deactivate"}
        title="Deactivate sub-account?"
        body="Enrichment will stop for this location until you reactivate it."
        confirmLabel="Deactivate"
        onCancel={() => setConfirm(null)}
        onConfirm={() =>
          runAction(async () => {
            await api.deactivate(connection.locationId);
            setConfirm(null);
            await load();
          })
        }
      />
      <ConfirmDialog
        open={confirm === "delete"}
        title="Delete sub-account?"
        body="This permanently removes the connection and its stored key. This cannot be undone."
        confirmLabel="Delete"
        destructive
        onCancel={() => setConfirm(null)}
        onConfirm={() =>
          runAction(async () => {
            await api.deleteConnection(connection.locationId);
            navigate("/");
          })
        }
      />
    </Box>
  );
}

function BackLink() {
  return (
    <Link component={RouterLink} to="/" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}>
      <ArrowBackIcon fontSize="small" /> All sub-accounts
    </Link>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <Grid item xs={12} sm={6} md={3}>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body2" sx={{ fontFamily: mono ? "monospace" : undefined, wordBreak: "break-all" }}>
        {value}
      </Typography>
    </Grid>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <Grid item xs={6} sm={4} md={2}>
      <Typography variant="h5" fontWeight={700}>
        {value}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
    </Grid>
  );
}

function SectionPaper({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Paper sx={{ p: 3, mt: 3 }}>
      <Typography variant="h6" sx={{ mb: 1.5 }}>
        {title}
      </Typography>
      {children}
    </Paper>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <Typography variant="body2" color="text.secondary">
      {children}
    </Typography>
  );
}

function EventTable({
  events,
  isMobile,
}: {
  events: LocationStatusDetail["enrichment"]["recent"];
  isMobile: boolean;
}) {
  // On a phone the 5-column table would force horizontal scroll, so each event
  // renders as a self-contained card instead (JAK-149).
  if (isMobile) {
    return (
      <Stack spacing={1.5}>
        {events.map((e) => (
          <Card key={`${e.contactId}-${e.updatedAt}`} variant="outlined">
            <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
              <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 1 }}>
                <Typography variant="body2" sx={{ fontFamily: "monospace", minWidth: 0, wordBreak: "break-all" }}>
                  {e.contactId}
                </Typography>
                <Chip size="small" label={e.status} sx={{ flexShrink: 0 }} />
              </Box>
              {e.detail && (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, wordBreak: "break-word" }}>
                  {e.detail}
                </Typography>
              )}
              <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
                {e.attemptCount} attempt{e.attemptCount === 1 ? "" : "s"} ·{" "}
                {new Date(e.updatedAt).toLocaleString()}
              </Typography>
            </CardContent>
          </Card>
        ))}
      </Stack>
    );
  }

  return (
    <Box sx={{ overflowX: "auto" }}>
    <Table size="small" sx={{ minWidth: 560 }}>
      <TableHead>
        <TableRow>
          <TableCell>Contact</TableCell>
          <TableCell>Status</TableCell>
          <TableCell>Detail</TableCell>
          <TableCell align="right">Attempts</TableCell>
          <TableCell>Updated</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {events.map((e) => (
          <TableRow key={`${e.contactId}-${e.updatedAt}`}>
            <TableCell sx={{ fontFamily: "monospace" }}>{e.contactId}</TableCell>
            <TableCell>{e.status}</TableCell>
            <TableCell sx={{ maxWidth: 320, whiteSpace: "normal", wordBreak: "break-word" }}>
              {e.detail ?? "—"}
            </TableCell>
            <TableCell align="right">{e.attemptCount}</TableCell>
            <TableCell>{new Date(e.updatedAt).toLocaleString()}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
    </Box>
  );
}
