import { type LocalisedText, type SupportedLocale } from "./types";

/**
 * All UI string keys used in the app.
 * Each key maps to a LocalisedText with at least `en` defined.
 * Add new keys here as features are translated.
 *
 * Categories: role labels, tab labels, action buttons, question types,
 * status messages, and assorted shell/coordinator/voter copy.
 */
export const UI_STRINGS = {
  // ── Role labels ──────────────────────────────────────────────────
  roleVoter: { en: "Voter", fr: "Électeur", ta: "வாக்காளர்" },
  roleOrganiser: { en: "Organiser", fr: "Organisateur", ta: "ஒருங்கிணைப்பாளர்" },
  roleObserver: { en: "Observer", fr: "Observateur", ta: "பார்வையாளர்" },

  // ── Tab labels ───────────────────────────────────────────────────
  tabFindOrganiser: { en: "Find organiser", fr: "Trouver un organisateur", ta: "ஒருங்கிணைப்பாளரைக் கண்டுபிடி" },
  tabVote: { en: "Vote", fr: "Voter", ta: "வாக்களி" },
  tabMessages: { en: "Messages", fr: "Messages", ta: "செய்திகள்" },
  tabSettings: { en: "Settings", fr: "Paramètres", ta: "அமைப்புகள்" },

  // ── Action buttons ───────────────────────────────────────────────
  actionSubmit: { en: "Submit", fr: "Soumettre", ta: "சமர்ப்பிக்க" },
  actionCancel: { en: "Cancel", fr: "Annuler", ta: "ரத்துசெய்" },
  actionPublish: { en: "Publish", fr: "Publier", ta: "வெளியிடு" },
  actionSave: { en: "Save", fr: "Enregistrer", ta: "சேமி" },
  actionClose: { en: "Close", fr: "Fermer", ta: "மூடு" },
  actionRetry: { en: "Retry", fr: "Réessayer", ta: "மீண்டும் முயற்சி" },
  actionCopy: { en: "Copy", fr: "Copier", ta: "நகலெடு" },
  actionCopied: { en: "Copied", fr: "Copié", ta: "நகலெடுக்கப்பட்டது" },
  actionSignOut: { en: "Sign out", fr: "Se déconnecter", ta: "வெளியேறு" },
  actionLogin: { en: "Login", fr: "Connexion", ta: "உள்நுழை" },
  actionContinue: { en: "Continue", fr: "Continuer", ta: "தொடர்" },
  actionDownloadBackup: { en: "Download backup", fr: "Télécharger la sauvegarde", ta: "காப்புப்பிரதியைப் பதிவிறக்கு" },
  actionDownloaded: { en: "Downloaded", fr: "Téléchargé", ta: "பதிவிறக்கப்பட்டது" },
  actionGoLive: { en: "Go Live", fr: "Mettre en ligne", ta: "நேரலைக்குச் செல்" },
  actionGoingLive: { en: "Going live...", fr: "Mise en ligne...", ta: "நேரலைக்குச் செல்கிறது..." },
  actionCloseAndPublish: { en: "Close & Publish", fr: "Fermer et publier", ta: "மூடி வெளியிடு" },
  actionPublishResults: { en: "Publish results", fr: "Publier les résultats", ta: "முடிவுகளை வெளியிடு" },
  actionAddQuestion: { en: "Add a Question", fr: "Ajouter une question", ta: "கேள்வியைச் சேர்" },
  actionDelete: { en: "Delete", fr: "Supprimer", ta: "நீக்கு" },
  actionEdit: { en: "Edit", fr: "Modifier", ta: "திருத்து" },
  actionRemove: { en: "Remove", fr: "Retirer", ta: "அகற்று" },
  actionBack: { en: "Back", fr: "Retour", ta: "பின்" },
  actionNext: { en: "Next", fr: "Suivant", ta: "அடுத்து" },
  actionRefresh: { en: "Refresh", fr: "Actualiser", ta: "புதுப்பி" },

  // ── Question types ───────────────────────────────────────────────
  questionTypeYesNo: { en: "Yes / No", fr: "Oui / Non", ta: "ஆம் / இல்லை" },
  questionTypeMultipleChoice: { en: "Multiple choice", fr: "Choix multiple", ta: "பல தேர்வு" },
  questionTypeRank: { en: "Ranked", fr: "Classement", ta: "தரவரிசை" },
  questionTypeFreeText: { en: "Free text", fr: "Texte libre", ta: "கட்டற்ற உரை" },

  // ── Status messages ──────────────────────────────────────────────
  statusComplete: { en: "Complete", fr: "Terminé", ta: "முடிந்தது" },
  statusPending: { en: "Pending", fr: "En attente", ta: "நிலுவையில்" },
  statusOptional: { en: "Optional", fr: "Optionnel", ta: "விருப்பத்தேர்வு" },
  statusRequired: { en: "Required", fr: "Obligatoire", ta: "கட்டாயம்" },
  statusPublished: { en: "Published", fr: "Publié", ta: "வெளியிடப்பட்டது" },
  statusClosed: { en: "Closed", fr: "Fermé", ta: "மூடப்பட்டது" },
  statusDraft: { en: "Draft", fr: "Brouillon", ta: "வரைவு" },
  statusLoading: { en: "Loading", fr: "Chargement", ta: "ஏற்றுகிறது" },
  statusWaiting: { en: "Waiting", fr: "En attente", ta: "காத்திருக்கிறது" },
  statusNoClosingTime: { en: "No closing time", fr: "Pas d'heure de clôture", ta: "மூடும் நேரம் இல்லை" },
  statusPendingActivation: { en: "Pending activation", fr: "Activation en attente", ta: "செயல்படுத்தல் நிலுவையில்" },
  statusClosedByAuditProxy: { en: "Closed by audit proxy", fr: "Fermé par le proxy d'audit", ta: "தணிக்கை ப்ராக்ஸியால் மூடப்பட்டது" },

  // ── Language switcher ────────────────────────────────────────────
  languageLabel: { en: "Language", fr: "Langue", ta: "மொழி" },
  languageEnglish: { en: "English", fr: "Anglais", ta: "ஆங்கிலம்" },
  languageFrench: { en: "French", fr: "Français", ta: "பிரெஞ்சு" },
  languageTamil: { en: "Tamil", fr: "Tamoul", ta: "தமிழ்" },

  // ── Theme ────────────────────────────────────────────────────────
  themeToggle: { en: "Toggle theme", fr: "Changer de thème", ta: "தீம் மாற்று" },

  // ── Shell / account menu ─────────────────────────────────────────
  menuLabel: { en: "Menu", fr: "Menu", ta: "பட்டி" },
  appMenuLabel: { en: "App menu", fr: "Menu de l'application", ta: "பயன்பாட்டு பட்டி" },
  closeMenuLabel: { en: "Close menu", fr: "Fermer le menu", ta: "பட்டியை மூடு" },
  mainActionsLabel: { en: "Main actions", fr: "Actions principales", ta: "முக்கிய செயல்கள்" },
  observerPagesLabel: { en: "Observer pages", fr: "Pages d'observateur", ta: "பார்வையாளர் பக்கங்கள்" },
  questionnaireResultsLabel: { en: "Questionnaire Results", fr: "Résultats du questionnaire", ta: "கேள்வித்தாள் முடிவுகள்" },
  relaysLabel: { en: "Relays", fr: "Relais", ta: "ரிலேக்கள்" },
  changeViewLabel: { en: "Change View", fr: "Changer de vue", ta: "காட்சியை மாற்று" },
  identityLabel: { en: "Identity", fr: "Identité", ta: "அடையாளம்" },
  qrCodeLabel: { en: "QR code", fr: "Code QR", ta: "QR குறியீடு" },
  newIdentityLabel: { en: "New identity", fr: "Nouvelle identité", ta: "புதிய அடையாளம்" },
  aboutLabel: { en: "About", fr: "À propos", ta: "பற்றி" },
  demoGuideLabel: { en: "Demo guide", fr: "Guide de démonstration", ta: "டெமோ வழிகாட்டி" },
  enterNsecLabel: { en: "Enter nsec", fr: "Saisir la nsec", ta: "nsec ஐ உள்ளிடு" },
  advancedLabel: { en: "Advanced", fr: "Avancé", ta: "மேம்பட்டது" },
  orLoginExisting: { en: "Or login using existing profile:", fr: "Ou connectez-vous avec un profil existant :", ta: "அல்லது ஏற்கனவே உள்ள சுயவிவரத்துடன் உள்நுழையவும்:" },
  copyNostrConnectUrl: { en: "Copy nostr-connect URL", fr: "Copier l'URL nostr-connect", ta: "nostr-connect URL ஐ நகலெடு" },
  copyNsecBunkerUrl: { en: "Copy nsec-bunker URL", fr: "Copier l'URL nsec-bunker", ta: "nsec-bunker URL ஐ நகலெடு" },
  selectRoleLabel: { en: "Select role", fr: "Sélectionner un rôle", ta: "பங்கைத் தேர்ந்தெடு" },
  identityLoading: { en: "Identity loading", fr: "Chargement de l'identité", ta: "அடையாளம் ஏற்றுகிறது" },
  copyIdentity: { en: "Copy identity", fr: "Copier l'identité", ta: "அடையாளத்தை நகலெடு" },
  howItWorks: { en: "How it works", fr: "Comment ça marche", ta: "இது எப்படி செயல்படுகிறது" },
  appVersionLabel: { en: "App version", fr: "Version de l'application", ta: "பயன்பாட்டு பதிப்பு" },
  signOutConfirm: { en: "Sign out and return to the landing page?", fr: "Se déconnecter et revenir à la page d'accueil ?", ta: "வெளியேறி முகப்புப் பக்கத்திற்குத் திரும்பவா?" },

  // ── Coordinator readiness ────────────────────────────────────────
  readinessTitleDescription: { en: "Title & Description", fr: "Titre et description", ta: "தலைப்பு மற்றும் விளக்கம்" },
  readinessInfo: { en: "Info", fr: "Infos", ta: "தகவல்" },
  readinessQuestions: { en: "Questions", fr: "Questions", ta: "கேள்விகள்" },
  readinessPublished: { en: "Published", fr: "Publié", ta: "வெளியிடப்பட்டது" },
  readinessPub: { en: "Pub", fr: "Pub", ta: "வெளி" },
  readinessProxySetup: { en: "Proxy Setup", fr: "Configuration du proxy", ta: "ப்ராக்ஸி அமைப்பு" },
  readinessProxy: { en: "Proxy", fr: "Proxy", ta: "ப்ராக்ஸி" },
  readinessResultsVoters: { en: "Results & Voters", fr: "Résultats et électeurs", ta: "முடிவுகள் மற்றும் வாக்காளர்கள்" },
  readinessVoters: { en: "Voters", fr: "Électeurs", ta: "வாக்காளர்கள்" },

  // ── Voter panel ──────────────────────────────────────────────────
  answerYes: { en: "Yes", fr: "Oui", ta: "ஆம்" },
  answerNo: { en: "No", fr: "Non", ta: "இல்லை" },
  actionPrevious: { en: "Previous", fr: "Précédent", ta: "முந்தையது" },
  voterQuestion: { en: "Question", fr: "Question", ta: "கேள்வி" },
  voterNoPreviousQuestion: { en: "No previous question", fr: "Aucune question précédente", ta: "முந்தைய கேள்வி இல்லை" },
  voterNoNextQuestion: { en: "No next question", fr: "Aucune question suivante", ta: "அடுத்த கேள்வி இல்லை" },
  voterNextQuestion: { en: "Next question", fr: "Question suivante", ta: "அடுத்த கேள்வி" },
  voterViewResults: { en: "View results", fr: "Voir les résultats", ta: "முடிவுகளைக் காண்க" },
  voterSubmitted: { en: "Submitted", fr: "Soumis", ta: "சமர்ப்பிக்கப்பட்டது" },
  voterAccepted: { en: "Accepted", fr: "Accepté", ta: "ஏற்கப்பட்டது" },
  voterReady: { en: "Ready", fr: "Prêt", ta: "தயார்" },
  voterOf: { en: "of", fr: "sur", ta: "இல்" },
  voterAnswerQuestion: { en: "Answer question", fr: "Répondez à la question", ta: "கேள்விக்குப் பதிலளிக்கவும்" },
  voterWaitingCredential: { en: "Waiting for ballot credential", fr: "En attente du justificatif de vote", ta: "வாக்குச் சான்றிற்குக் காத்திருக்கிறது" },
  voterLoginToSubmit: { en: "Log in to submit", fr: "Connectez-vous pour soumettre", ta: "சமர்ப்பிக்க உள்நுழையவும்" },
  voterStart: { en: "Start", fr: "Commencer", ta: "தொடங்கு" },
  voterSolvingPow: { en: "Solving proof of work...", fr: "Calcul de la preuve de travail...", ta: "வேலைச் சான்றைக் கணக்கிடுகிறது..." },
  voterResumeBallot: { en: "Resume ballot request", fr: "Reprendre la demande de bulletin", ta: "வாக்குச் சீட்டுக் கோரிக்கையைத் தொடரவும்" },
  voterStartPow: { en: "Start proof of work", fr: "Démarrer la preuve de travail", ta: "வேலைச் சான்றைத் தொடங்கவும்" },
  voterRetrievingQuestions: { en: "Retrieving questions.", fr: "Récupération des questions.", ta: "கேள்விகளைப் பெறுகிறது." },
  voterQueuedPrivately: { en: "Queued privately", fr: "En file privée", ta: "தனிப்பட்ட வரிசையில் உள்ளது" },
  voterRejected: { en: "Rejected", fr: "Rejeté", ta: "நிராகரிக்கப்பட்டது" },
  voterSelectAll: { en: "Select all options that apply.", fr: "Sélectionnez toutes les options pertinentes.", ta: "பொருந்தும் அனைத்து விருப்பங்களையும் தேர்ந்தெடுக்கவும்." },
  voterSelectOne: { en: "Select one option.", fr: "Sélectionnez une option.", ta: "ஒரு விருப்பத்தைத் தேர்ந்தெடுக்கவும்." },
  voterEnterResponse: { en: "Enter your response.", fr: "Saisissez votre réponse.", ta: "உங்கள் பதிலை உள்ளிடவும்." },
  voterRankAtLeast: { en: "Rank at least {count} in order of preference.", fr: "Classez au moins {count} options par ordre de préférence.", ta: "குறைந்தது {count} விருப்பங்களை விருப்ப வரிசையில் தரவரிசைப்படுத்தவும்." },
  voterChooseToContinue: { en: "Choose {count} options to continue", fr: "Choisissez {count} options pour continuer", ta: "தொடர {count} விருப்பங்களைத் தேர்ந்தெடுக்கவும்" },
  voterChooseOneToContinue: { en: "Choose 1 option to continue", fr: "Choisissez 1 option pour continuer", ta: "தொடர 1 விருப்பத்தைத் தேர்ந்தெடுக்கவும்" },
  voterAllSubmitted: { en: "All question responses submitted.", fr: "Toutes les réponses ont été soumises.", ta: "அனைத்துக் கேள்விகளுக்குமான பதில்கள் சமர்ப்பிக்கப்பட்டன." },
  voterAnswerRequired: { en: "Answer required questions to continue", fr: "Répondez aux questions obligatoires pour continuer", ta: "தொடர கட்டாயக் கேள்விகளுக்குப் பதிலளிக்கவும்" },
  voterAnswerThisQuestion: { en: "Answer this question to continue", fr: "Répondez à cette question pour continuer", ta: "தொடர இந்தக் கேள்விக்குப் பதிலளிக்கவும்" },
  voterAnswerEachVote: { en: "Answer each separate vote to continue", fr: "Répondez à chaque vote séparé pour continuer", ta: "தொடர ஒவ்வொரு தனி வாக்கிற்கும் பதிலளிக்கவும்" },
  voterConfirmingIdentity: { en: "1/3 Confirming identity", fr: "1/3 Confirmation de l'identité", ta: "1/3 அடையாளத்தை உறுதிப்படுத்துகிறது" },
  voterFindingOrganiser: { en: "1/3 Finding organiser", fr: "1/3 Recherche de l'organisateur", ta: "1/3 ஒருங்கிணைப்பாளரைத் தேடுகிறது" },
  voterLoadingBallotKey: { en: "1/3 Loading ballot key", fr: "1/3 Chargement de la clé du bulletin", ta: "1/3 வாக்குச் சீட்டு விசையை ஏற்றுகிறது" },
  voterRequestingBallot: { en: "Requesting ballot", fr: "Demande de bulletin", ta: "வாக்குச் சீட்டைக் கோருகிறது" },
  voterAwaitingBallot: { en: "Awaiting ballot", fr: "En attente du bulletin", ta: "வாக்குச் சீட்டிற்குக் காத்திருக்கிறது" },
  voterPreparingResponse: { en: "3/3 Preparing response", fr: "3/3 Préparation de la réponse", ta: "3/3 பதிலைத் தயாரிக்கிறது" },
  voterQuestionnaire: { en: "Questionnaire", fr: "Questionnaire", ta: "கேள்வித்தாள்" },
  voterSubmitResponse: { en: "Submit response", fr: "Soumettre la réponse", ta: "பதிலைச் சமர்ப்பிக்க" },
  voterSubmitting: { en: "Submitting...", fr: "Soumission...", ta: "சமர்ப்பிக்கிறது..." },
  voterResponseSubmitted: { en: "Response submitted", fr: "Réponse soumise", ta: "பதில் சமர்ப்பிக்கப்பட்டது" },
  voterResponseSubmitFailed: { en: "Response submit failed.", fr: "Échec de la soumission de la réponse.", ta: "பதில் சமர்ப்பிப்பு தோல்வியடைந்தது." },
  voterNotSubmitted: { en: "Not submitted", fr: "Non soumis", ta: "சமர்ப்பிக்கப்படவில்லை" },
  voterTokenReady: { en: "Token ready", fr: "Jeton prêt", ta: "டோக்கன் தயார்" },
  voterAnswersEncrypted: { en: "Answers are encrypted", fr: "Les réponses sont chiffrées", ta: "பதில்கள் மறைகுறியாக்கப்பட்டுள்ளன" },
  voterAnswersPublic: { en: "Answers are public", fr: "Les réponses sont publiques", ta: "பதில்கள் பொதுவானவை" },
  voterResponderMarker: { en: "Your responder marker", fr: "Votre marqueur de répondant", ta: "உங்கள் பதிலளிப்பாளர் குறி" },
  voterRestoredQuestionnaire: { en: "Restored questionnaire", fr: "Questionnaire restauré", ta: "மீட்டெடுக்கப்பட்ட கேள்வித்தாள்" },
  voterParticipationHistory: { en: "Participation history", fr: "Historique de participation", ta: "பங்கேற்பு வரலாறு" },
  voterUntitledQuestion: { en: "Untitled question", fr: "Question sans titre", ta: "தலைப்பில்லாத கேள்வி" },
  voterNoQuestionnaireLoaded: { en: "No questionnaire loaded.", fr: "Aucun questionnaire chargé.", ta: "கேள்வித்தாள் ஏற்றப்படவில்லை." },
  voterQuestionnaireNotOpen: { en: "Questionnaire is not open.", fr: "Le questionnaire n'est pas ouvert.", ta: "கேள்வித்தாள் திறக்கப்படவில்லை." },
  voterAlreadySubmitted: { en: "Response already submitted for this questionnaire.", fr: "Réponse déjà soumise pour ce questionnaire.", ta: "இந்தக் கேள்வித்தாளுக்கு பதில் ஏற்கனவே சமர்ப்பிக்கப்பட்டது." },
  voterRefreshFailed: { en: "Questionnaire refresh failed.", fr: "Échec de l'actualisation du questionnaire.", ta: "கேள்வித்தாள் புதுப்பிப்பு தோல்வியடைந்தது." },
  voterStreamDisconnected: { en: "Questionnaire live stream disconnected.", fr: "Flux en direct du questionnaire déconnecté.", ta: "கேள்வித்தாள் நேரலை இணைப்பு துண்டிக்கப்பட்டது." },
  voterOneTimeTokenNote: { en: "This response is submitted using a one-time token.", fr: "Cette réponse est soumise à l'aide d'un jeton à usage unique.", ta: "இந்தப் பதில் ஒருமுறை பயன்படுத்தும் டோக்கன் மூலம் சமர்ப்பிக்கப்படுகிறது." },

  // ── Coordinator panel ────────────────────────────────────────────
  coordinatorDemoTitle: { en: "Neighbourhood Consultation Demo", fr: "Démo de consultation de quartier", ta: "அக்கம்பக்க ஆலோசனை டெமோ" },
  coordinatorDemoQuestion: { en: "Do you support creating a shared community garden?", fr: "Soutenez-vous la création d'un jardin communautaire partagé ?", ta: "பகிரப்பட்ட சமூகத் தோட்டத்தை உருவாக்குவதை ஆதரிக்கிறீர்களா?" },
  coordinatorDemoReady: { en: "Demo questionnaire ready. Review it, then select Go Live to publish.", fr: "Questionnaire de démo prêt. Vérifiez-le, puis sélectionnez Mettre en ligne pour publier.", ta: "டெமோ கேள்வித்தாள் தயார். மதிப்பாய்வு செய்து, வெளியிட நேரலைக்குச் செல் என்பதைத் தேர்ந்தெடுக்கவும்." },
  coordinatorOptionOne: { en: "Option 1", fr: "Option 1", ta: "விருப்பம் 1" },
  coordinatorOptionTwo: { en: "Option 2", fr: "Option 2", ta: "விருப்பம் 2" },
  coordinatorQuestionTypeLabel: { en: "type", fr: "type", ta: "வகை" },
  coordinatorVoterGroupLabel: { en: "voter group", fr: "groupe d'électeurs", ta: "வாக்காளர் குழு" },
  coordinatorRequiredLabel: { en: "Required", fr: "Obligatoire", ta: "கட்டாயம்" },
  coordinatorPublishing: { en: "Publishing...", fr: "Publication...", ta: "வெளியிடுகிறது..." },
  coordinatorClosingPublishing: { en: "Closing and publishing...", fr: "Fermeture et publication...", ta: "மூடி வெளியிடுகிறது..." },
  coordinatorPublishFailed: { en: "Publish failed", fr: "Échec de la publication", ta: "வெளியீடு தோல்வியடைந்தது" },
  coordinatorReadyToPublish: { en: "Ready to publish", fr: "Prêt à publier", ta: "வெளியிடத் தயார்" },
  coordinatorMoveQuestionsBack: { en: "Move questions back to Main before removing this voter group.", fr: "Déplacez les questions vers Principal avant de supprimer ce groupe d'électeurs.", ta: "இந்த வாக்காளர் குழுவை அகற்றும் முன் கேள்விகளை முதன்மைக்கு நகர்த்தவும்." },
} as const satisfies Record<string, LocalisedText>;

export type UiStringKey = keyof typeof UI_STRINGS;

/**
 * Look up a UI string for a given locale.
 * @param key - Key from UI_STRINGS
 * @param locale - Requested locale (falls back to en)
 * @returns Resolved string
 */
export function t(key: UiStringKey, locale: SupportedLocale): string {
  const entry = UI_STRINGS[key];
  if (!entry) {
    return key; // graceful degradation for missing keys
  }
  return resolveLocalisedText(entry, locale);
}

// Import inline to avoid circular deps with index.ts
import { resolveLocalised } from "./resolveLocale";

function resolveLocalisedText(text: LocalisedText, locale: SupportedLocale): string {
  return resolveLocalised(text, locale);
}
