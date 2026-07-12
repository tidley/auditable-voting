import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { nip19 } from "nostr-tools";
import QRCode from "qrcode";
import SimpleAuditorApp from "./SimpleAuditorApp";
import SimpleCoordinatorApp from "./SimpleCoordinatorApp";
import SimpleRelayPanel from "./SimpleRelayPanel";
import SimpleUiApp, { type VoterTab } from "./SimpleUiApp";
import { SIMPLE_APP_VERSION } from "./simpleAppVersion";
import { createAmberConnectBundle, createSignerService, SignerServiceError } from "./services/signerService";
import { deriveNpubFromNsec } from "./nostrIdentity";
import {
  downloadSimpleActorBackup,
  loadSimpleActorState,
  saveSimpleActorState,
  type SimpleActorRole,
} from "./simpleLocalState";
import { tryWriteClipboard } from "./clipboard";
import SimpleQrPanel from "./SimpleQrPanel";
import TokenFingerprint from "./TokenFingerprint";
import { deriveActorDisplayId, formatQuestionnaireDisplayId } from "./actorDisplay";
import { useTransientCopiedLabel } from "./useTransientCopiedLabel";
import { UiButton, UiTextField, type UiIconName } from "./ui/DesignLayer";
import { hasVoterInviteContextInUrl } from "./questionnaireInvite";

type SimpleRole = "voter" | "coordinator" | "auditor";
type AuditorPage = "gallery" | "relays";
const GATEWAY_SIGNER_NPUB_STORAGE_KEY = "app:auditable-voting:gateway:signer_npub";
const AMBER_FULLY_TRUST_HINT = "Change from `Approve basic actions` to `I fully trust this application` when Amber opens. This allows the application to fully coordinate.";
const ROLE_OPTIONS: Array<{ role: SimpleRole; label: string }> = [
  { role: "auditor", label: "Observer" },
  { role: "coordinator", label: "Organiser" },
  { role: "voter", label: "Voter" },
];
const ACCOUNT_MENU_ROLE_OPTIONS: Array<{ role: SimpleRole; label: string }> = [
  { role: "voter", label: "Voter" },
  { role: "coordinator", label: "Organiser" },
  { role: "auditor", label: "Observer" },
];
const VOTER_SECTION_OPTIONS: Array<{ tab: VoterTab; label: string; icon: string }> = [
  { tab: "configure", label: "Find organiser", icon: "join" },
  { tab: "vote", label: "Vote", icon: "vote" },
  { tab: "messages", label: "Messages", icon: "messages" },
  { tab: "settings", label: "Settings", icon: "settings" },
];
const IDENTITY_UPDATED_EVENT = "auditable-voting:identity-updated";
const PUBLIC_LINK_FRESH_VOTER_PARAM = "fresh_voter";

function voterTabIconName(icon: string): UiIconName {
  if (icon === "messages") {
    return "message";
  }
  if (icon === "settings") {
    return "settings";
  }
  if (icon === "vote") {
    return "clipboard";
  }
  return "search";
}

function roleIconName(role: SimpleRole): UiIconName {
  if (role === "coordinator") {
    return "users";
  }
  if (role === "voter") {
    return "clipboard";
  }
  return "view";
}

type SimpleAppShellProps = {
  initialRole?: SimpleRole;
};

function readRoleFromUrl(): SimpleRole | null {
  if (typeof window === "undefined") {
    return null;
  }

  const role = new URLSearchParams(window.location.search).get("role");
  if (role === "voter" || role === "coordinator" || role === "auditor") {
    return role;
  }

  return null;
}

function hasRoleInUrl() {
  if (typeof window === "undefined") {
    return false;
  }
  return Boolean(new URLSearchParams(window.location.search).get("role"));
}

function shouldForceGatewayFromUrl() {
  if (typeof window === "undefined") {
    return false;
  }
  const params = new URLSearchParams(window.location.search);
  return params.get("login") === "1";
}

function readLinkedQuestionnaireIdFromUrl() {
  if (typeof window === "undefined") {
    return "";
  }
  const params = new URLSearchParams(window.location.search);
  return (params.get("q") ?? params.get("election_id") ?? params.get("questionnaire") ?? "").trim();
}

function shouldCreateFreshVoterForPublicLink() {
  if (typeof window === "undefined") {
    return false;
  }
  const params = new URLSearchParams(window.location.search);
  return Boolean(
    hasVoterInviteContextInUrl()
    && params.get(PUBLIC_LINK_FRESH_VOTER_PARAM) !== "1"
    && !params.get("nsec")?.trim()
  );
}

function markFreshVoterCreatedForPublicLink() {
  if (typeof window === "undefined") {
    return;
  }
  const url = new URL(window.location.href);
  url.searchParams.set(PUBLIC_LINK_FRESH_VOTER_PARAM, "1");
  window.history.replaceState({}, "", url.toString());
}

function writeRoleToUrl(role: SimpleRole) {
  if (typeof window === "undefined") {
    return;
  }

  const url = new URL(window.location.href);
  url.searchParams.set("role", role);
  url.searchParams.delete("login");
  window.history.replaceState({}, "", url.toString());
}

function clearVoterInviteUrlContext() {
  if (typeof window === "undefined") {
    return;
  }

  const url = new URL(window.location.href);
  for (const key of [
    "q",
    "election_id",
    "questionnaire",
    "coordinator",
    "invited",
    "invite",
    "invite_code",
    "code",
    "request_ballot",
    "auto_request",
    PUBLIC_LINK_FRESH_VOTER_PARAM,
  ]) {
    url.searchParams.delete(key);
  }
  window.history.replaceState({}, "", url.toString());
}

function getLandingPageUrl() {
  if (typeof window === "undefined") {
    return "/";
  }
  return new URL(import.meta.env.BASE_URL || "/", window.location.origin).toString();
}

function returnToLandingPage() {
  if (typeof window === "undefined") {
    return;
  }
  window.location.assign(getLandingPageUrl());
}

function roleLabel(role: SimpleRole) {
  return ROLE_OPTIONS.find((entry) => entry.role === role)?.label ?? "Observer";
}

function isSimpleActorRole(role: SimpleRole): role is SimpleActorRole {
  return role === "voter" || role === "coordinator";
}

type MenuIconName = SimpleRole | "menu" | "copy" | "new" | "key-refresh" | "login" | "signout" | "info" | "book";

function MenuIcon({ name }: { name: MenuIconName }) {
  return (
    <svg className='simple-account-menu-svg-icon' viewBox='0 0 24 24' aria-hidden='true' focusable='false'>
      {name === "auditor" ? (
        <>
          <circle cx='12' cy='7' r='3.5' />
          <path d='M5.5 20v-2.2c0-3.1 2.8-5.3 6.5-5.3s6.5 2.2 6.5 5.3V20z' />
        </>
      ) : name === "coordinator" ? (
        <>
          <circle cx='12' cy='7' r='2.8' />
          <circle cx='6.8' cy='9' r='2.2' />
          <circle cx='17.2' cy='9' r='2.2' />
          <path d='M8 20v-2.1c0-2.6 1.7-4.4 4-4.4s4 1.8 4 4.4V20z' />
          <path d='M3.5 19v-1.5c0-2.1 1.3-3.5 3.3-3.5' />
          <path d='M20.5 19v-1.5c0-2.1-1.3-3.5-3.3-3.5' />
        </>
      ) : name === "voter" ? (
        <>
          <path d='M8 4h8l1.5 4H6.5z' />
          <path d='M5 8h14v12H5z' />
          <path d='M9 13h6' />
          <path d='M10.5 5.5l3 1.8' />
        </>
      ) : name === "menu" ? (
        <>
          <path d='M5 7h14' />
          <path d='M5 12h14' />
          <path d='M5 17h14' />
        </>
      ) : name === "copy" ? (
        <>
          <rect x='8' y='7' width='10' height='12' rx='2' />
          <path d='M6 16H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1' />
        </>
      ) : name === "new" ? (
        <>
          <circle cx='12' cy='12' r='7' />
          <path d='M12 8v8' />
          <path d='M8 12h8' />
        </>
      ) : name === "key-refresh" ? (
        <>
          <path d='M18.5 7.5A7 7 0 0 0 6 8.8' />
          <path d='M18.5 7.5V3.8' />
          <path d='M18.5 7.5h-3.7' />
          <path d='M5.5 16.5A7 7 0 0 0 18 15.2' />
          <path d='M5.5 16.5v3.7' />
          <path d='M5.5 16.5h3.7' />
          <circle cx='9' cy='12' r='2.3' />
          <path d='M11.3 12h6.2' />
          <path d='M15.2 12v2.2' />
          <path d='M17.5 12v1.7' />
        </>
      ) : name === "login" ? (
        <>
          <path d='M9 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3' />
          <path d='M12 8l4 4-4 4' />
          <path d='M16 12H7' />
        </>
      ) : name === "signout" ? (
        <>
          <path d='M10 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4' />
          <path d='M14 8l4 4-4 4' />
          <path d='M18 12H9' />
        </>
      ) : name === "info" ? (
        <>
          <circle cx='12' cy='12' r='8' />
          <path d='M12 11v5' />
          <path d='M12 8h.01' />
        </>
      ) : (
        <>
          <path d='M4 5.5h6.5A3.5 3.5 0 0 1 14 9v10H7.5A3.5 3.5 0 0 0 4 15.5z' />
          <path d='M20 5.5h-6.5A3.5 3.5 0 0 0 10 9v10h6.5a3.5 3.5 0 0 1 3.5-3.5z' />
        </>
      )}
    </svg>
  );
}

function isMobileBrowser() {
  if (typeof navigator === "undefined") {
    return false;
  }
  return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent || "");
}

export default function SimpleAppShell({ initialRole = "auditor" }: SimpleAppShellProps) {
  const [role, setRole] = useState<SimpleRole>(() => readRoleFromUrl() ?? initialRole);
  const [voterTab, setVoterTab] = useState<VoterTab>(() => (readLinkedQuestionnaireIdFromUrl() ? "vote" : "configure"));
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [auditorPage, setAuditorPage] = useState<AuditorPage>("gallery");
  const [voterMessagesUnread, setVoterMessagesUnread] = useState(false);
  const [activeVoterQuestionnaireId, setActiveVoterQuestionnaireId] = useState("");
  const [activeVoterBallotReceived, setActiveVoterBallotReceived] = useState(false);
  const activeVoterQuestionnaireIdRef = useRef("");
  const [accountIdentityNpub, setAccountIdentityNpub] = useState("");
  const [accountIdentityDialogOpen, setAccountIdentityDialogOpen] = useState<"qr" | null>(null);
  const [accountIdentityQrSrc, setAccountIdentityQrSrc] = useState<string | null>(null);
  const [newIdentityConfirmRole, setNewIdentityConfirmRole] = useState<SimpleActorRole | null>(null);
  const [newIdentityBackupStatus, setNewIdentityBackupStatus] = useState<string | null>(null);
  const [showGateway, setShowGateway] = useState(() => !hasRoleInUrl() || shouldForceGatewayFromUrl());
  const [gatewayRole, setGatewayRole] = useState<SimpleRole>(() => readRoleFromUrl() ?? initialRole);
  const [gatewayNsec, setGatewayNsec] = useState("");
  const [gatewaySignerNpub, setGatewaySignerNpub] = useState("");
  const [gatewayStatus, setGatewayStatus] = useState<string | null>(null);
  const [gatewayNsecOpen, setGatewayNsecOpen] = useState(false);
  const [gatewayAdvancedOpen, setGatewayAdvancedOpen] = useState(false);
  const [gatewayNostrConnectUri, setGatewayNostrConnectUri] = useState("");
  const [gatewayNsecBunkerUri, setGatewayNsecBunkerUri] = useState("");
  const [gatewayShowConnectQr, setGatewayShowConnectQr] = useState(false);
  const { isCopied: isCopyLabelActive, showCopied: showCopyLabel } = useTransientCopiedLabel();
  const roleSwitchWrapRef = useRef<HTMLDivElement | null>(null);
  const publicLinkFreshVoterDispatchedRef = useRef(false);
  const preferredSignerLabel = useMemo(() => (isMobileBrowser() ? "Amber" : "NOS2X-FOX"), []);
  const preferredSignerIsAmber = preferredSignerLabel === "Amber";
  const accountIdentityLabel = accountIdentityNpub ? deriveActorDisplayId(accountIdentityNpub) : "pending";
  const accountMenuButtonLabel = role === "coordinator"
    ? accountIdentityNpub
      ? `Open organiser profile menu for ${accountIdentityLabel}`
      : "Open organiser profile menu"
    : role === "voter"
      ? accountIdentityNpub
        ? `Open voter profile menu for ${accountIdentityLabel}${voterMessagesUnread ? ", new message" : ""}`
        : `Open voter profile menu${voterMessagesUnread ? ", new message" : ""}`
      : "Menu";
  const isPublicVoterInvite = role === "voter" && hasVoterInviteContextInUrl();
  const voterSectionOptions = useMemo(() => (
    isPublicVoterInvite
      ? VOTER_SECTION_OPTIONS.filter((option) => option.tab !== "configure" && option.tab !== "settings")
      : VOTER_SECTION_OPTIONS
  ), [isPublicVoterInvite]);

  useEffect(() => {
    if (role !== "voter") {
      setVoterMessagesUnread(false);
    }
    if (role !== "auditor") {
      setAuditorPage("gallery");
    }
  }, [role]);

  useEffect(() => {
    if (role !== "voter" || publicLinkFreshVoterDispatchedRef.current || !shouldCreateFreshVoterForPublicLink()) {
      return;
    }
    publicLinkFreshVoterDispatchedRef.current = true;
    markFreshVoterCreatedForPublicLink();
    window.dispatchEvent(new CustomEvent("auditable-voting:voter-new", {
      detail: { preserveInviteContext: true },
    }));
  }, [role]);

  useEffect(() => {
    if (role === "voter" && !voterSectionOptions.some((option) => option.tab === voterTab)) {
      setVoterTab("vote");
    }
  }, [role, voterSectionOptions, voterTab]);

  useEffect(() => {
    if (role !== "voter" && role !== "coordinator") {
      setAccountIdentityNpub("");
      setAccountIdentityDialogOpen(null);
      setNewIdentityConfirmRole(null);
      setNewIdentityBackupStatus(null);
      return;
    }

    let cancelled = false;
    const persistedSignerNpub = typeof window === "undefined"
      ? ""
      : window.localStorage.getItem(GATEWAY_SIGNER_NPUB_STORAGE_KEY)?.trim() ?? "";
    setAccountIdentityNpub(persistedSignerNpub);

    loadSimpleActorState(role)
      .then((state) => {
        if (cancelled) {
          return;
        }
        const loadedNpub = state?.keypair?.npub?.trim() || persistedSignerNpub;
        setAccountIdentityNpub((current) => loadedNpub || current);
      })
        .catch(() => {
          if (!cancelled) {
            setAccountIdentityNpub((current) => persistedSignerNpub || current);
          }
        });

    return () => {
      cancelled = true;
    };
  }, [role]);

  useEffect(() => {
    if (!accountIdentityNpub.trim()) {
      setAccountIdentityQrSrc(null);
      return;
    }

    let cancelled = false;
    void QRCode.toDataURL(accountIdentityNpub, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 432,
      color: {
        dark: "#0b0c0c",
        light: "#ffffff",
      },
    }).then((value: string) => {
      if (!cancelled) {
        setAccountIdentityQrSrc(value);
      }
    }).catch(() => {
      if (!cancelled) {
        setAccountIdentityQrSrc(null);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [accountIdentityNpub]);

  useEffect(() => {
    if (!accountIdentityDialogOpen) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAccountIdentityDialogOpen(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [accountIdentityDialogOpen]);

  useEffect(() => {
    if (!newIdentityConfirmRole) {
      setNewIdentityBackupStatus(null);
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setNewIdentityConfirmRole(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [newIdentityConfirmRole]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleIdentityUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ role?: SimpleRole; npub?: string; nsec?: string }>).detail;
      if (!detail || detail.role !== role) {
        return;
      }
      setAccountIdentityNpub(detail.npub?.trim() ?? "");
    };

    window.addEventListener(IDENTITY_UPDATED_EVENT, handleIdentityUpdated);
    return () => window.removeEventListener(IDENTITY_UPDATED_EVENT, handleIdentityUpdated);
  }, [role]);

  useEffect(() => {
    if (!accountMenuOpen || typeof document === "undefined") {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const wrapper = roleSwitchWrapRef.current;
      const target = event.target;
      if (!wrapper || !(target instanceof Node) || wrapper.contains(target)) {
        return;
      }
      setAccountMenuOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [accountMenuOpen]);

  async function preserveLocalIdentityForRoleSwitch(nextRole: SimpleRole) {
    if (role === nextRole || !isSimpleActorRole(role) || !isSimpleActorRole(nextRole)) {
      return;
    }

    try {
      const currentState = await loadSimpleActorState(role);
      if (!currentState?.keypair?.nsec?.trim() || !currentState.keypair.npub.trim()) {
        return;
      }
      const targetState = await loadSimpleActorState(nextRole);
      await saveSimpleActorState({
        role: nextRole,
        keypair: currentState.keypair,
        updatedAt: new Date().toISOString(),
        cache: targetState?.cache,
      });
      setAccountIdentityNpub(currentState.keypair.npub);
    } catch {
      // Locked or unavailable local state should not block role switching.
    }
  }

  const handleRoleSelect = async (nextRole: SimpleRole) => {
    setAccountMenuOpen(false);
    await preserveLocalIdentityForRoleSwitch(nextRole);
    setRole(nextRole);
  };

  const handleVoterIdentityChange = useCallback((npub: string) => {
    setAccountIdentityNpub(npub.trim());
  }, []);
  const handleActiveVoterQuestionnaireIdChange = useCallback((questionnaireId: string) => {
    const nextQuestionnaireId = questionnaireId.trim();
    if (activeVoterQuestionnaireIdRef.current === nextQuestionnaireId) {
      return;
    }
    activeVoterQuestionnaireIdRef.current = nextQuestionnaireId;
    setActiveVoterQuestionnaireId(nextQuestionnaireId);
    setActiveVoterBallotReceived(false);
  }, []);

  useEffect(() => {
    if (showGateway) {
      return;
    }
    writeRoleToUrl(role);
  }, [role, showGateway]);

  const gatewayRoleTitle = useMemo(() => roleLabel(gatewayRole), [gatewayRole]);
  const currentRoleSummary = useMemo(() => (
    isSimpleActorRole(role) ? `${roleLabel(role)} ${accountIdentityLabel}` : roleLabel(role)
  ), [accountIdentityLabel, role]);
  const newIdentityConfirmLabel = newIdentityConfirmRole ? roleLabel(newIdentityConfirmRole) : "";
  const newIdentityConfirmShortId = newIdentityConfirmRole === role && accountIdentityNpub
    ? deriveActorDisplayId(accountIdentityNpub)
    : "";
  const gatewayContinueLabel = useMemo(() => {
    const hasSignerIdentity = gatewaySignerNpub.trim().length > 0;
    return `${hasSignerIdentity ? "Login" : "Continue"} as ${gatewayRoleTitle}`;
  }, [gatewayRoleTitle, gatewaySignerNpub]);

  function confirmNewIdentity() {
    if (!newIdentityConfirmRole || typeof window === "undefined") {
      return;
    }
    const targetRole = newIdentityConfirmRole;
    setNewIdentityConfirmRole(null);
    setAccountMenuOpen(false);
    if (targetRole === "voter") {
      clearVoterInviteUrlContext();
    }
    window.dispatchEvent(new Event(`auditable-voting:${targetRole}-new`));
  }

  async function downloadIdentityBackupBeforeReset() {
    if (!newIdentityConfirmRole) {
      return false;
    }
    try {
      const state = await loadSimpleActorState(newIdentityConfirmRole);
      if (!state?.keypair?.nsec?.trim()) {
        setNewIdentityBackupStatus("No local profile backup is available for this identity.");
        return false;
      }
      await downloadSimpleActorBackup(newIdentityConfirmRole, state.keypair, state.cache);
      setNewIdentityBackupStatus("Backup downloaded.");
      return true;
    } catch {
      setNewIdentityBackupStatus("Could not download backup. Restore or unlock this profile first.");
      return false;
    }
  }

  async function loginWithSigner() {
    try {
      const signer = createSignerService();
      const rawPubkey = await signer.getPublicKey();
      const npub = rawPubkey.startsWith("npub1") ? rawPubkey : nip19.npubEncode(rawPubkey);
      setGatewaySignerNpub(npub);
      setGatewayStatus(`Signer connected: ${npub}`);
      if (gatewayRole === "voter" && readLinkedQuestionnaireIdFromUrl()) {
        if (typeof window !== "undefined") {
          window.localStorage.setItem(GATEWAY_SIGNER_NPUB_STORAGE_KEY, npub);
        }
        setRole("voter");
        setShowGateway(false);
      }
      return npub;
    } catch (error) {
      if (error instanceof SignerServiceError) {
        setGatewayStatus(error.message);
        return null;
      }
      setGatewayStatus("Signer login failed.");
      return null;
    }
  }

  async function runSignerLogin(options?: { continueAfterLogin?: boolean }) {
    if (preferredSignerIsAmber) {
      setGatewayStatus(AMBER_FULLY_TRUST_HINT);
      const npub = await loginWithSigner();
      if (!npub) {
        await prepareAmberConnectLinks();
        return;
      }
      if (options?.continueAfterLogin) {
        if (typeof window !== "undefined") {
          window.localStorage.setItem(GATEWAY_SIGNER_NPUB_STORAGE_KEY, npub);
        }
        setRole(gatewayRole);
        setShowGateway(false);
      }
      return;
    }
    const npub = await loginWithSigner();
    if (npub && options?.continueAfterLogin) {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(GATEWAY_SIGNER_NPUB_STORAGE_KEY, npub);
      }
      setRole(gatewayRole);
      setShowGateway(false);
    }
  }

  async function continueFromGateway() {
    const trimmedNsec = gatewayNsec.trim();
    if (trimmedNsec && (gatewayRole === "voter" || gatewayRole === "coordinator")) {
      const npub = deriveNpubFromNsec(trimmedNsec);
      if (!npub) {
        setGatewayStatus("Enter a valid nsec before continuing.");
        return;
      }
      await saveSimpleActorState({
        role: gatewayRole,
        keypair: { nsec: trimmedNsec, npub },
        updatedAt: new Date().toISOString(),
      });
      setGatewayStatus(`Loaded ${gatewayRole} identity ${npub}.`);
    }
    if (typeof window !== "undefined") {
      if (gatewaySignerNpub.trim()) {
        window.localStorage.setItem(GATEWAY_SIGNER_NPUB_STORAGE_KEY, gatewaySignerNpub.trim());
      } else {
        window.localStorage.removeItem(GATEWAY_SIGNER_NPUB_STORAGE_KEY);
      }
    }
    setRole(gatewayRole);
    setShowGateway(false);
  }

  async function prepareAmberConnectLinks() {
    try {
      const bundle = await createAmberConnectBundle();
      setGatewayNostrConnectUri(bundle.nostrConnectUri);
      setGatewayNsecBunkerUri(bundle.nsecBunkerUri);
      setGatewayShowConnectQr(true);
      setGatewayStatus("Nostr Connect links ready. Scan the QR or copy a URL.");
    } catch (error) {
      if (error instanceof Error && error.message.trim()) {
        setGatewayStatus(error.message);
        return;
      }
      setGatewayStatus("Could not prepare Nostr Connect links.");
    }
  }

  async function ensureAmberConnectLinks() {
    if (gatewayNostrConnectUri.trim() && gatewayNsecBunkerUri.trim()) {
      return {
        nostrConnectUri: gatewayNostrConnectUri,
        nsecBunkerUri: gatewayNsecBunkerUri,
      };
    }
    const bundle = await createAmberConnectBundle();
    setGatewayNostrConnectUri(bundle.nostrConnectUri);
    setGatewayNsecBunkerUri(bundle.nsecBunkerUri);
    return bundle;
  }

  async function copyValueWithFeedback(value: string, key: string) {
    if (!value.trim()) {
      return false;
    }
    const copied = await tryWriteClipboard(value);
    if (copied) {
      showCopyLabel(key);
    }
    return copied;
  }

  async function copyGatewayValue(value: string, label: string, key: string) {
    if (!value.trim()) {
      return;
    }
    const copied = await copyValueWithFeedback(value, key);
    setGatewayStatus(copied ? `${label} copied.` : `Could not copy ${label.toLowerCase()}.`);
  }

  async function copyPreparedGatewayValue(kind: "nostr-connect" | "nsec-bunker") {
    try {
      const bundle = await ensureAmberConnectLinks();
      const value = kind === "nostr-connect" ? bundle.nostrConnectUri : bundle.nsecBunkerUri;
      await copyGatewayValue(
        value,
        kind === "nostr-connect" ? "Nostr Connect URL" : "nsec-bunker URL",
        `gateway-${kind}`,
      );
    } catch (error) {
      setGatewayStatus(error instanceof Error && error.message.trim() ? error.message : "Could not prepare Nostr Connect links.");
    }
  }

  if (showGateway) {
    return (
      <div className='simple-app-shell'>
        <section className='simple-login-gateway' aria-label='Login and role selection'>
          <div className='simple-login-brand'>
            <div className='simple-login-brand-mark' aria-hidden='true'>
              <TokenFingerprint tokenId='auditable-voting' compact showQr={false} hideMetadata />
            </div>
            <div className='simple-login-brand-copy'>
              <h1 className='simple-login-title'>Auditable Voting</h1>
            </div>
          </div>

          <label className='simple-voter-label simple-login-role-label'>Select role</label>
          <div className='simple-role-switch simple-role-switch-login' role='tablist' aria-label='Role selection'>
            {ROLE_OPTIONS.map((option) => (
              <UiButton
                key={option.role}
                icon={roleIconName(option.role)}
                role='tab'
                aria-selected={gatewayRole === option.role}
                className={`simple-role-switch-button${gatewayRole === option.role ? " is-active" : ""}`}
                onPress={() => setGatewayRole(option.role)}
              >
                <span>{option.label}</span>
              </UiButton>
            ))}
          </div>

          <div className='simple-login-actions'>
            <UiButton icon='login' className='simple-voter-primary' onPress={() => void continueFromGateway()}>
              {gatewayContinueLabel}
            </UiButton>
          </div>

          <div className='simple-login-existing'>
            <p className='simple-login-existing-title'>Or login using existing profile:</p>
            <div className='simple-login-actions simple-login-existing-actions'>
              <UiButton
                icon='login'
                className='simple-voter-secondary'
                onPress={() => void runSignerLogin({ continueAfterLogin: true })}
              >
                {preferredSignerLabel}
              </UiButton>
              <UiButton
                icon='key'
                className='simple-voter-secondary'
                aria-expanded={gatewayNsecOpen}
                aria-controls='gateway-nsec-panel'
                onPress={() => {
                  setGatewayNsecOpen((current) => !current);
                  setGatewayAdvancedOpen(false);
                }}
              >
                Enter nsec
              </UiButton>
              <UiButton
                icon='settings'
                className='simple-voter-secondary'
                aria-expanded={gatewayAdvancedOpen}
                aria-controls='gateway-advanced-panel'
                onPress={() => {
                  setGatewayAdvancedOpen((current) => !current);
                  setGatewayNsecOpen(false);
                }}
              >
                Advanced
              </UiButton>
            </div>
          </div>

          {gatewayNsecOpen ? (
            <section id='gateway-nsec-panel' className='simple-login-panel' aria-label='nsec login'>
              <UiTextField
                label='Enter nsec'
                inputClassName='simple-voter-input'
                inputProps={{
                  id: 'gateway-nsec',
                  value: gatewayNsec,
                  onChange: (event) => setGatewayNsec(event.target.value),
                  placeholder: 'nsec1...',
                  spellCheck: false,
                  autoCapitalize: 'off',
                  autoCorrect: 'off',
                }}
              />
              <div className='simple-login-actions'>
                <UiButton icon='login' className='simple-voter-primary' onPress={() => void continueFromGateway()}>
                  Continue with nsec
                </UiButton>
              </div>
            </section>
          ) : null}

          {gatewayAdvancedOpen ? (
            <section id='gateway-advanced-panel' className='simple-login-panel' aria-label='Advanced signer options'>
              <div className='simple-login-actions simple-login-advanced-actions'>
                <UiButton
                  icon={isCopyLabelActive("gateway-nostr-connect") ? "check" : "copy"}
                  className='simple-voter-secondary'
                  onPress={() => void copyPreparedGatewayValue("nostr-connect")}
                >
                  {isCopyLabelActive("gateway-nostr-connect") ? "Copied" : "Copy nostr-connect URL"}
                </UiButton>
                <UiButton
                  icon={isCopyLabelActive("gateway-nsec-bunker") ? "check" : "copy"}
                  className='simple-voter-secondary'
                  onPress={() => void copyPreparedGatewayValue("nsec-bunker")}
                >
                  {isCopyLabelActive("gateway-nsec-bunker") ? "Copied" : "Copy nsec-bunker URL"}
                </UiButton>
                <UiButton
                  icon='qr'
                  className='simple-voter-secondary'
                  onPress={() => void prepareAmberConnectLinks()}
                >
                  Show nostr-connect QR
                </UiButton>
              </div>
              {gatewaySignerNpub ? <p className='simple-voter-note'>Signer: {gatewaySignerNpub}</p> : null}
              {gatewayShowConnectQr && gatewayNostrConnectUri.trim() ? (
                <SimpleQrPanel
                  value={gatewayNostrConnectUri}
                  title='Nostr Connect URL'
                  description='Scan in Amber or copy this URL directly.'
                  copyLabel='Copy nostr-connect URL'
                  downloadFilename='nostr-connect-qr.png'
                />
              ) : null}
            </section>
          ) : null}
          {gatewayStatus ? <p className='simple-voter-note'>{gatewayStatus}</p> : null}
        </section>
        <footer className='simple-app-version' aria-label='App version'>
          <span>v{SIMPLE_APP_VERSION}</span>
          <a href='project-explainer.html' target='_blank' rel='noopener noreferrer'>How it works</a>
        </footer>
      </div>
    );
  }

  const accountMenuControl = (
    <div className='simple-account-menu-wrap' ref={roleSwitchWrapRef}>
      <UiButton
        icon='menu'
        className={`simple-role-switch-toggle simple-account-menu-toggle${role === "coordinator" ? " simple-account-profile-toggle" : ""}${role === "voter" && voterMessagesUnread ? " has-unread-message is-breathing" : ""}`}
        onPress={() => {
          setAccountMenuOpen((current) => !current);
        }}
        aria-haspopup='menu'
        aria-expanded={accountMenuOpen}
        aria-controls='simple-app-menu'
        aria-label={accountMenuButtonLabel}
      >
        {role === "coordinator" ? (
          <>
            <span className='simple-account-profile-copy'>
              <span className='simple-account-menu-kicker'>Organiser</span>
              <span className='simple-account-profile-title'>{accountIdentityLabel}</span>
              <span className='simple-account-profile-npub' title={accountIdentityNpub || undefined}>
                {accountIdentityNpub || "Identity loading"}
              </span>
            </span>
          </>
        ) : role === "voter" ? (
          <>
            <span className='simple-account-menu-trigger-icon is-compat-hidden' aria-hidden='true' />
            <span className='simple-account-menu-trigger-text'>{accountIdentityLabel}</span>
          </>
        ) : (
          "Menu"
        )}
      </UiButton>
      {accountMenuOpen ? (
        <>
          <div
            className='simple-account-menu-backdrop'
            aria-hidden='true'
            onClick={() => setAccountMenuOpen(false)}
          />
          <div
            id='simple-app-menu'
            className='simple-account-menu simple-main-menu'
            role='menu'
            aria-label='App menu'
          >
          <UiButton
            icon='cancel'
            iconOnly
            className='simple-account-menu-close'
            aria-label='Close menu'
            onPress={() => setAccountMenuOpen(false)}
          />
          <p
            className='simple-account-menu-title'
            data-tooltip={accountIdentityNpub ? `Full identity: ${accountIdentityNpub}` : undefined}
          >
            {isSimpleActorRole(role) ? accountIdentityLabel : roleLabel(role)}
          </p>
          {role === "voter" ? (
            <div className='simple-account-menu-section simple-account-menu-section-nav' role='none'>
              <div
                className='simple-role-switch simple-role-switch-menu-inline simple-voter-menu-switch'
                role='tablist'
                aria-label='Main actions'
              >
                {voterSectionOptions.map((option) => (
                  <UiButton
                    key={option.tab}
                    icon={voterTabIconName(option.icon)}
                    role='tab'
                    aria-selected={voterTab === option.tab}
                    className={`simple-role-switch-button${voterTab === option.tab ? ' is-active' : ''}${option.tab === "messages" && voterMessagesUnread ? ' has-unread-message' : ''}`}
                    onPress={() => {
                      setVoterTab(option.tab);
                      if (option.tab === "messages") {
                        setVoterMessagesUnread(false);
                      }
                      setAccountMenuOpen(false);
                    }}
                  >
                    {option.tab === "messages" && voterMessagesUnread ? <span className='simple-message-unread-dot' /> : null}
                    <span>{option.label}</span>
                  </UiButton>
                ))}
              </div>
            </div>
          ) : null}
          {role === "voter" ? <div id='simple-voter-menu-actions' role='none' /> : null}
          {role === "auditor" ? (
            <div className='simple-account-menu-section simple-account-menu-section-nav' role='none'>
              <div
                className='simple-role-switch simple-role-switch-menu-inline simple-auditor-menu-switch'
                role='tablist'
                aria-label='Observer pages'
              >
                <UiButton
                  icon='view'
                  role='tab'
                  aria-selected={auditorPage === "gallery"}
                  className={`simple-role-switch-button${auditorPage === "gallery" ? ' is-active' : ''}`}
                  onPress={() => {
                    setAuditorPage("gallery");
                    setAccountMenuOpen(false);
                  }}
                >
                  <span>Questionnaire Results</span>
                </UiButton>
                <UiButton
                  icon='share'
                  role='tab'
                  aria-selected={auditorPage === "relays"}
                  className={`simple-role-switch-button${auditorPage === "relays" ? ' is-active' : ''}`}
                  onPress={() => {
                    setAuditorPage("relays");
                    setAccountMenuOpen(false);
                  }}
                >
                  <span>Relays</span>
                </UiButton>
              </div>
            </div>
          ) : null}
          {role === "auditor" && auditorPage === "gallery" ? <div id='simple-auditor-menu-filters' role='none' /> : null}
          <div className='simple-account-menu-section' role='none'>
            <p className='simple-account-menu-kicker'>Change View</p>
            <div
              className='simple-role-switch simple-role-switch-menu-inline'
              role='tablist'
              aria-label='Simple role switch'
            >
              {ACCOUNT_MENU_ROLE_OPTIONS.map((option) => (
                <UiButton
                  key={option.role}
                  icon={roleIconName(option.role)}
                  role='tab'
                  aria-selected={role === option.role}
                  className={`simple-role-switch-button${role === option.role ? ' is-active' : ''}`}
                  onPress={() => {
                    void handleRoleSelect(option.role);
                  }}
                >
                  <span>{option.label}</span>
                </UiButton>
              ))}
            </div>
          </div>
          {isSimpleActorRole(role) && !(role === "voter" && isPublicVoterInvite) ? (
            <>
              <div className='simple-account-menu-section simple-account-menu-identity' role='none'>
                <p className='simple-account-menu-kicker'>Identity</p>
                {accountIdentityNpub ? (
                  <div className='simple-account-menu-identity-grid' role='none'>
                    <UiButton
                      icon='qr'
                      className='simple-account-menu-button simple-account-menu-tile simple-account-menu-visual-tile'
                      role='menuitem'
                      onPress={() => {
                        setAccountMenuOpen(false);
                        setAccountIdentityDialogOpen("qr");
                      }}
                    >
                      <span>QR code</span>
                    </UiButton>
                    <UiButton
                      icon={isCopyLabelActive("account-identity") ? "check" : "copy"}
                      className='simple-account-menu-button simple-account-menu-tile'
                      role='menuitem'
                      onPress={() => {
                        void copyValueWithFeedback(accountIdentityNpub, "account-identity");
                      }}
                    >
                      <span>{isCopyLabelActive("account-identity") ? "Copied" : "Copy identity"}</span>
                    </UiButton>
                    <UiButton
                      icon='add'
                      className='simple-account-menu-button simple-account-menu-tile'
                      role='menuitem'
                      onPress={() => {
                        setAccountMenuOpen(false);
                        setNewIdentityConfirmRole(role);
                      }}
                    >
                      <span>New identity</span>
                    </UiButton>
                  </div>
                ) : null}
                {!accountIdentityNpub ? (
                  <p className='simple-voter-note simple-account-menu-note'>Identity is loading.</p>
                ) : null}
              </div>
            </>
          ) : null}
          <div className='simple-account-menu-section simple-account-menu-about-section' role='none'>
            <p className='simple-account-menu-kicker'>About</p>
            <div className='simple-account-menu-about-row' role='none'>
              <a
                className='simple-account-menu-button simple-account-menu-link'
                role='menuitem'
                href='project-explainer.html'
                target='_blank'
                rel='noopener noreferrer'
                onClick={() => setAccountMenuOpen(false)}
              >
                <MenuIcon name='info' />
                <span>How it works</span>
              </a>
              <a
                className='simple-account-menu-button simple-account-menu-link'
                role='menuitem'
                href='demo-guide.html'
                target='_blank'
                rel='noopener noreferrer'
                onClick={() => setAccountMenuOpen(false)}
              >
                <MenuIcon name='book' />
                <span>Demo guide</span>
              </a>
              <p className='simple-account-menu-version'>v{SIMPLE_APP_VERSION}</p>
            </div>
          </div>
          {isSimpleActorRole(role) ? (
            <div className='simple-account-menu-signout-section' role='none'>
              <UiButton
                icon='logout'
                className='simple-account-menu-button simple-account-menu-action simple-account-menu-signout-button'
                role='menuitem'
                onPress={() => {
                  if (
                    typeof window !== "undefined"
                    && !window.confirm("Sign out and return to the landing page?")
                  ) {
                    return;
                  }
                  setAccountMenuOpen(false);
                  if (typeof window !== "undefined") {
                    window.dispatchEvent(new Event(`auditable-voting:${role}-signout`));
                    returnToLandingPage();
                  }
                }}
              >
                <span>Sign out</span>
              </UiButton>
            </div>
          ) : null}
          </div>
        </>
      ) : null}
    </div>
  );

  return (
    <div className={`simple-app-shell${role === "coordinator" ? " simple-app-shell-coordinator" : ""}`}>
      {role === "coordinator" ? null : (
        <div className={`simple-role-switch-wrap${role === "auditor" ? " simple-auditor-topbar-wrap" : ""}`}>
          <div className='simple-role-switch-topbar'>
            {accountMenuControl}
            {role === "auditor" && auditorPage === "gallery" ? (
              <div id='simple-auditor-topbar-actions' className='simple-auditor-topbar-actions' />
            ) : null}
            {role === "voter" && activeVoterQuestionnaireId ? (
              <p
                className={`simple-voter-topbar-questionnaire-id${activeVoterBallotReceived ? " has-ballot" : ""}`}
                title={activeVoterQuestionnaireId}
              >
                {formatQuestionnaireDisplayId(activeVoterQuestionnaireId)}
              </p>
            ) : null}
            {role === "voter" ? null : isSimpleActorRole(role) && accountIdentityNpub ? (
              <UiButton
                icon='qr'
                className='simple-role-switch-toggle simple-current-role-summary simple-current-role-button'
                onPress={() => setAccountIdentityDialogOpen("qr")}
                aria-haspopup='dialog'
                aria-label={`Show full ${roleLabel(role).toLowerCase()} npub QR`}
              >
                {currentRoleSummary}
              </UiButton>
            ) : (
              null
            )}
          </div>
        </div>
      )}

      {role === 'voter' ? (
        <SimpleUiApp
          activeTab={voterTab}
          onActiveTabChange={setVoterTab}
          onIdentityChange={handleVoterIdentityChange}
          onActiveQuestionnaireIdChange={handleActiveVoterQuestionnaireIdChange}
          onBallotReceivedChange={setActiveVoterBallotReceived}
          onUnreadMessagesChange={setVoterMessagesUnread}
          showSectionTabs={false}
        />
      ) : role === 'coordinator' ? (
        <SimpleCoordinatorApp accountMenu={accountMenuControl} />
      ) : auditorPage === "relays" ? (
        <main className='simple-voter-shell simple-auditor-shell simple-relays-shell'>
          <SimpleRelayPanel standalone />
        </main>
      ) : (
        <SimpleAuditorApp
          filtersInMenu
          filtersMenuOpen={accountMenuOpen && role === "auditor"}
          onFiltersMenuClose={() => setAccountMenuOpen(false)}
        />
      )}
      {accountIdentityDialogOpen && accountIdentityNpub ? (
        <div
          className='simple-identity-qr-overlay simple-account-identity-overlay'
          role='dialog'
          aria-modal='true'
          aria-label={`${roleLabel(role)} npub QR code`}
          onClick={() => setAccountIdentityDialogOpen(null)}
        >
          <UiButton
            icon='cancel'
            className='simple-identity-qr-overlay-close'
            onPress={() => setAccountIdentityDialogOpen(null)}
            aria-label='Close npub QR preview'
          >
            Close
          </UiButton>
          <div
            className='simple-identity-qr-overlay-card simple-account-identity-overlay-card'
            onClick={(event) => event.stopPropagation()}
          >
            <div className='simple-account-identity-overlay-copy'>
              <p className='simple-account-menu-kicker'>{roleLabel(role)} identity</p>
              <h2 className='simple-voter-section-title'>
                QR code
              </h2>
              <code className='simple-account-identity-full-npub'>{accountIdentityNpub}</code>
            </div>
            {accountIdentityQrSrc ? (
              <img
                className='simple-identity-qr-overlay-image simple-account-identity-overlay-image'
                src={accountIdentityQrSrc}
                alt={`QR code for ${roleLabel(role)} npub`}
              />
            ) : (
              <div
                className='simple-identity-qr-overlay-image simple-account-identity-overlay-image simple-identity-qr-fallback'
                aria-hidden='true'
              />
            )}
          </div>
        </div>
      ) : null}
      {newIdentityConfirmRole ? (
        <div
          className='simple-identity-qr-overlay simple-new-identity-confirm-overlay'
          role='dialog'
          aria-modal='true'
          aria-labelledby='new-identity-confirm-title'
          aria-describedby='new-identity-confirm-description'
          onClick={() => setNewIdentityConfirmRole(null)}
        >
          <UiButton
            icon='cancel'
            iconOnly
            className='simple-identity-qr-overlay-close simple-new-identity-confirm-close'
            onPress={() => setNewIdentityConfirmRole(null)}
            aria-label='Cancel new identity'
          />
          <div
            className='simple-identity-qr-overlay-card simple-new-identity-confirm-card'
            onClick={(event) => event.stopPropagation()}
          >
            <div className='simple-new-identity-confirm-mark' aria-hidden='true'>
              <MenuIcon name='key-refresh' />
            </div>
            <div className='simple-new-identity-confirm-copy'>
              <p className='simple-account-menu-kicker'>New {newIdentityConfirmLabel} identity</p>
              <h2 id='new-identity-confirm-title' className='simple-voter-section-title'>Are you sure?</h2>
              <p id='new-identity-confirm-description' className='simple-voter-note'>
                Make sure you have backed up this profile if you intend to use it again.
              </p>
              {newIdentityConfirmShortId ? (
                <p className='simple-new-identity-confirm-current'>
                  Current profile <strong>{newIdentityConfirmShortId}</strong>
                </p>
              ) : null}
              <div className='simple-new-identity-confirm-warning'>
                <span className='simple-new-identity-confirm-warning-icon' aria-hidden='true'>i</span>
                <div>
                  <p>This action cannot be undone.</p>
                  <span>Creating a new identity replaces the current local profile for this role.</span>
                </div>
              </div>
            </div>
            <div className='simple-new-identity-confirm-actions'>
              <UiButton
                icon='cancel'
                variant='secondary'
                className='simple-voter-secondary'
                onPress={() => setNewIdentityConfirmRole(null)}
              >
                Cancel
              </UiButton>
              <UiButton
                icon={isCopyLabelActive("new-identity-backup") ? "check" : "download"}
                variant='secondary'
                className='simple-voter-secondary simple-new-identity-confirm-backup'
                onPress={() => {
                  void downloadIdentityBackupBeforeReset().then((downloaded) => {
                    if (downloaded) {
                      showCopyLabel("new-identity-backup");
                    }
                  });
                }}
              >
                {isCopyLabelActive("new-identity-backup") ? "Downloaded" : "Download backup"}
              </UiButton>
              <UiButton
                icon='key'
                variant='primary'
                className='simple-voter-primary simple-new-identity-confirm-primary'
                onPress={confirmNewIdentity}
              >
                Create new identity
              </UiButton>
            </div>
            {newIdentityBackupStatus ? (
              <p className='simple-new-identity-confirm-status' role='status'>{newIdentityBackupStatus}</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
