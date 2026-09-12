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

  // ── Paper ballots (coordinator) ──────────────────────────────────
  paperBallotsTitle: { en: "Paper ballots", fr: "Bulletins papier", ta: "காகித வாக்குச்சீட்டுகள்" },
  paperBallotsIntro: { en: "Generate paper ballots with fresh voter keypairs (nsec/npub). Each ballot prints the questionnaire, the voter identity and the voting instructions. Print them and hand them to voters who cannot use the digital client.", fr: "Générez des bulletins papier avec de nouvelles paires de clés (nsec/npub). Chaque bulletin imprime le questionnaire, l'identité de l'électeur et les instructions de vote. Imprimez-les et remettez-les aux électeurs qui ne peuvent pas utiliser le client numérique.", ta: "புதிய வாக்காளர் விசை ஜோடிகளுடன் (nsec/npub) காகித வாக்குச்சீட்டுகளை உருவாக்குங்கள். ஒவ்வொரு வாக்குச்சீட்டிலும் கேள்வித்தாள், வாக்காளர் அடையாளம் மற்றும் வாக்களிக்கும் வழிமுறைகள் அச்சிடப்படும். அவற்றை அச்சிட்டு, மின்னணு செயலியைப் பயன்படுத்த முடியாத வாக்காளர்களிடம் கொடுங்கள்." },
  paperBallotsSecurityNote: { en: "A paper ballot carries a private key (nsec). Print it on a trusted printer and hand it to its voter in person.", fr: "Un bulletin papier contient une clé privée (nsec). Imprimez-le sur une imprimante de confiance et remettez-le en main propre à son électeur.", ta: "காகித வாக்குச்சீட்டில் தனிப்பட்ட விசை (nsec) உள்ளது. நம்பகமான அச்சுப்பொறியில் அச்சிட்டு, வாக்காளரிடம் நேரடியாகக் கொடுங்கள்." },
  paperBallotsCountLabel: { en: "Number of ballots", fr: "Nombre de bulletins", ta: "வாக்குச்சீட்டுகளின் எண்ணிக்கை" },
  paperBallotsGenerate: { en: "Generate paper ballots", fr: "Générer les bulletins papier", ta: "காகித வாக்குச்சீட்டுகளை உருவாக்கு" },
  paperBallotsGenerating: { en: "Generating...", fr: "Génération...", ta: "உருவாக்கப்படுகிறது..." },
  paperBallotsNoQuestionnaire: { en: "Publish a questionnaire before generating paper ballots.", fr: "Publiez un questionnaire avant de générer des bulletins papier.", ta: "காகித வாக்குச்சீட்டுகளை உருவாக்கும் முன் கேள்வித்தாளை வெளியிடுங்கள்." },
  paperBallotsNoDefinition: { en: "This questionnaire is not cached on this device, so its definition could not be loaded.", fr: "Ce questionnaire n'est pas mis en cache sur cet appareil ; sa définition n'a pas pu être chargée.", ta: "இந்தக் கேள்வித்தாள் இந்தச் சாதனத்தில் சேமிக்கப்படவில்லை; அதன் வரையறையை ஏற்ற முடியவில்லை." },
  paperBallotsInvalidCount: { en: "Enter a whole number of ballots between 1 and 500.", fr: "Saisissez un nombre entier de bulletins entre 1 et 500.", ta: "1 முதல் 500 வரை முழு எண்ணிக்கையில் வாக்குச்சீட்டுகளை உள்ளிடுங்கள்." },
  paperBallotsAdmittedHint: { en: "Admitted voters: {count}", fr: "Électeurs admis : {count}", ta: "அனுமதிக்கப்பட்ட வாக்காளர்கள்: {count}" },
  paperBallotsResultsTitle: { en: "Generated ballots", fr: "Bulletins générés", ta: "உருவாக்கப்பட்ட வாக்குச்சீட்டுகள்" },
  paperBallotsReady: { en: "Ballots generated: {count}", fr: "Bulletins générés : {count}", ta: "உருவாக்கப்பட்ட வாக்குச்சீட்டுகள்: {count}" },
  paperBallotsPartial: { en: "Ballots generated: {count}. Failed: {errors}.", fr: "Bulletins générés : {count}. Échecs : {errors}.", ta: "உருவாக்கப்பட்டவை: {count}. தோல்வி: {errors}." },
  paperBallotsFailed: { en: "Could not generate paper ballots: {message}", fr: "Impossible de générer les bulletins papier : {message}", ta: "காகித வாக்குச்சீட்டுகளை உருவாக்க முடியவில்லை: {message}" },
  paperBallotsPrintAll: { en: "Print all", fr: "Tout imprimer", ta: "அனைத்தையும் அச்சிடு" },
  paperBallotsViewBallot: { en: "View ballot {index}", fr: "Voir le bulletin {index}", ta: "வாக்குச்சீட்டு {index} ஐப் பார்" },
  paperBallotsHideBallot: { en: "Hide ballot {index}", fr: "Masquer le bulletin {index}", ta: "வாக்குச்சீட்டு {index} ஐ மறை" },

  // ── Paper ballot manual entry (F3-T4) ────────────────────────────
  tabEnterPaperBallot: { en: "Enter paper ballot", fr: "Saisir un bulletin papier", ta: "காகித வாக்குச்சீட்டை உள்ளிடு" },
  paperBallotEntryTitle: { en: "Enter a paper ballot", fr: "Saisir un bulletin papier", ta: "காகித வாக்குச்சீட்டை உள்ளிடவும்" },
  paperBallotEntryIntro: { en: "Enter the answers from a completed paper ballot so it is submitted through the same flow as a digital vote. The private key printed on the ballot is used as the voter identity.", fr: "Saisissez les réponses d'un bulletin papier rempli afin qu'il soit soumis par le même circuit qu'un vote numérique. La clé privée imprimée sur le bulletin sert d'identité d'électeur.", ta: "நிரப்பப்பட்ட காகித வாக்குச்சீட்டின் பதில்களை உள்ளிடுங்கள்; அவை மின்னணு வாக்குகளின் அதே வழிமுறையில் சமர்ப்பிக்கப்படும். வாக்குச்சீட்டில் அச்சிடப்பட்ட தனிப்பட்ட விசையே வாக்காளர் அடையாளமாகும்." },
  paperBallotEntrySecurityNote: { en: "Only enter a ballot that its voter has handed back. Anyone holding the printed key can vote as that voter.", fr: "Ne saisissez qu'un bulletin remis par son électeur. Toute personne détenant la clé imprimée peut voter à la place de cet électeur.", ta: "வாக்காளர் திருப்பித் தந்த வாக்குச்சீட்டை மட்டுமே உள்ளிடுங்கள். அச்சிடப்பட்ட விசையை வைத்திருப்பவர் யாராலும் அந்த வாக்காளராக வாக்களிக்க முடியும்." },
  paperBallotEntryNoQuestionnaire: { en: "This questionnaire is not cached on this device, so the ballot cannot be entered here. Open or publish the questionnaire first.", fr: "Ce questionnaire n'est pas mis en cache sur cet appareil ; le bulletin ne peut donc pas être saisi ici. Ouvrez ou publiez d'abord le questionnaire.", ta: "இந்தக் கேள்வித்தாள் இந்தச் சாதனத்தில் சேமிக்கப்படவில்லை, எனவே வாக்குச்சீட்டை இங்கே உள்ளிட முடியாது. முதலில் கேள்வித்தாளைத் திறக்கவும் அல்லது வெளியிடவும்." },
  paperBallotEntryNsecLabel: { en: "Ballot private key (nsec)", fr: "Clé privée du bulletin (nsec)", ta: "வாக்குச்சீட்டு தனிப்பட்ட விசை (nsec)" },
  paperBallotEntryNsecHint: { en: "Type or paste the nsec printed on the ballot.", fr: "Saisissez ou collez le nsec imprimé sur le bulletin.", ta: "வாக்குச்சீட்டில் அச்சிடப்பட்ட nsec ஐத் தட்டச்சு செய்யவும் அல்லது ஒட்டவும்." },
  paperBallotEntryInviteCodeLabel: { en: "Invite code (when the ballot carries one)", fr: "Code d'invitation (si le bulletin en comporte un)", ta: "அழைப்புக் குறியீடு (வாக்குச்சீட்டில் இருந்தால்)" },
  paperBallotEntryInviteCodePlaceholder: { en: "Invite code", fr: "Code d'invitation", ta: "அழைப்புக் குறியீடு" },
  paperBallotEntryConfirmIdentity: { en: "Confirm ballot identity", fr: "Confirmer l'identité du bulletin", ta: "வாக்குச்சீட்டு அடையாளத்தை உறுதிப்படுத்து" },
  paperBallotEntryIdentityTitle: { en: "Ballot identity", fr: "Identité du bulletin", ta: "வாக்குச்சீட்டு அடையாளம்" },
  paperBallotEntryVerifyIdentity: { en: "Check that this identity matches the ballot in your hand before entering answers.", fr: "Vérifiez que cette identité correspond au bulletin que vous avez en main avant de saisir les réponses.", ta: "பதில்களை உள்ளிடும் முன், இந்த அடையாளம் உங்கள் கையில் உள்ள வாக்குச்சீட்டுடன் பொருந்துகிறதா எனச் சரிபார்க்கவும்." },
  paperBallotEntryChangeIdentity: { en: "Use a different ballot", fr: "Utiliser un autre bulletin", ta: "வேறு வாக்குச்சீட்டைப் பயன்படுத்து" },
  paperBallotEntryAnswersTitle: { en: "Answers from the paper ballot", fr: "Réponses du bulletin papier", ta: "காகித வாக்குச்சீட்டின் பதில்கள்" },
  paperBallotEntryMissingAnswers: { en: "Answer every required question before submitting.", fr: "Répondez à toutes les questions obligatoires avant de soumettre.", ta: "சமர்ப்பிக்கும் முன் கட்டாயக் கேள்விகள் அனைத்திற்கும் பதிலளியுங்கள்." },
  paperBallotEntryNoCredential: { en: "This device holds no voting credential for this ballot, so it cannot be submitted here. Continue in the digital vote screen with the same key to request one, then submit.", fr: "Cet appareil ne détient aucun justificatif de vote pour ce bulletin ; il ne peut donc pas être soumis ici. Continuez dans l'écran de vote numérique avec la même clé pour en demander un, puis soumettez.", ta: "இந்தச் சாதனத்தில் இந்த வாக்குச்சீட்டுக்கான வாக்கு அனுமதிச்சீட்டு இல்லை, எனவே அதை இங்கே சமர்ப்பிக்க முடியாது. அதே விசையுடன் மின்னணு வாக்குத் திரையில் தொடர்ந்து ஒன்றைக் கோரி, பின்னர் சமர்ப்பிக்கவும்." },
  paperBallotEntryOpenDigitalFlow: { en: "Continue in the digital vote screen", fr: "Continuer dans l'écran de vote numérique", ta: "மின்னணு வாக்குத் திரையில் தொடரவும்" },
  paperBallotEntrySubmit: { en: "Submit paper ballot", fr: "Soumettre le bulletin papier", ta: "காகித வாக்குச்சீட்டைச் சமர்ப்பி" },
  paperBallotEntrySubmitting: { en: "Submitting...", fr: "Soumission...", ta: "சமர்ப்பிக்கப்படுகிறது..." },
  paperBallotEntrySubmitted: { en: "Paper ballot submitted. Submission: {id}", fr: "Bulletin papier soumis. Soumission : {id}", ta: "காகித வாக்குச்சீட்டு சமர்ப்பிக்கப்பட்டது. சமர்ப்பிப்பு: {id}" },
  paperBallotEntrySubmitFailed: { en: "Could not submit the paper ballot: {message}", fr: "Impossible de soumettre le bulletin papier : {message}", ta: "காகித வாக்குச்சீட்டைச் சமர்ப்பிக்க முடியவில்லை: {message}" },
  paperBallotEntryMissingNsec: { en: "Enter the private key printed on the ballot.", fr: "Saisissez la clé privée imprimée sur le bulletin.", ta: "வாக்குச்சீட்டில் அச்சிடப்பட்ட தனிப்பட்ட விசையை உள்ளிடுங்கள்." },
  paperBallotEntryPublicKeyOnly: { en: "That is the ballot's public key. Enter the private key (nsec) printed on the ballot.", fr: "Il s'agit de la clé publique du bulletin. Saisissez la clé privée (nsec) imprimée sur le bulletin.", ta: "அது வாக்குச்சீட்டின் பொது விசை. வாக்குச்சீட்டில் அச்சிடப்பட்ட தனிப்பட்ட விசையை (nsec) உள்ளிடுங்கள்." },
  paperBallotEntryInvalidNsec: { en: "That is not a valid ballot nsec. Check the printed key and try again.", fr: "Ce nsec de bulletin n'est pas valide. Vérifiez la clé imprimée et réessayez.", ta: "அது செல்லுபடியாகும் வாக்குச்சீட்டு nsec அல்ல. அச்சிடப்பட்ட விசையைச் சரிபார்த்து மீண்டும் முயற்சிக்கவும்." },
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
