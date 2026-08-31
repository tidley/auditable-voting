import { useEffect, useRef, useState } from "react";
import { TourGuideClient } from "@sjmc11/tourguidejs";
import "@sjmc11/tourguidejs/dist/css/tour.min.css";
import { UiButton } from "./ui/DesignLayer";

type Props = {
  showLauncher: boolean;
  onPrepareDemo: () => void;
  onShowVoters: () => void;
  onShowResults: () => void;
  publishedSignal: number;
  onExit: () => void;
};

export default function OrganiserDemoTour({ showLauncher, onPrepareDemo, onShowVoters, onShowResults, publishedSignal, onExit }: Props) {
  const tourRef = useRef<TourGuideClient | null>(null);
  const publishedSignalRef = useRef(0);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => () => {
    void tourRef.current?.exit();
  }, []);

  useEffect(() => {
    if (publishedSignal <= 0 || publishedSignal === publishedSignalRef.current || tourRef.current?.activeStep !== 0) {
      return;
    }
    publishedSignalRef.current = publishedSignal;
    void tourRef.current.nextStep();
  }, [publishedSignal]);

  function startTour() {
    onPrepareDemo();
    window.setTimeout(() => {
      const tour = new TourGuideClient({
        steps: [
          { title: "Publish the demo", content: "The questionnaire is pre-filled with a community-garden yes/no question. Select Go Live to publish this real questionnaire to your configured Nostr relays.", target: "[data-demo-target='publish']", group: "organiser-demo", propagateEvents: true },
          { title: "General invite", content: "Select the highlighted general invite control. This link lets anyone open the live questionnaire and request a blind ballot.", target: "#demo-general-invite", group: "organiser-demo", propagateEvents: true, beforeEnter: () => showVoters() },
          { title: "Private invite", content: "Create a one-voter private invite for the fictional recipient Avery Patel. The private link is separate from the public questionnaire announcement.", target: "#demo-private-invite", group: "organiser-demo", propagateEvents: true },
          { title: "Resident invitation preview", content: "Load the five sample residents. These records stay in this browser and are never published to Nostr. Resident registration is separate from blind ballot submission, so an organiser cannot link a resident to a vote. Email OTP delivery is planned but is not available yet.", target: "#demo-resident-import", group: "organiser-demo", propagateEvents: true },
          { title: "Live dashboard", content: "The questionnaire is live. Results will appear here as anonymous blind ballots are accepted.", target: "#coordinator-results-nav", group: "organiser-demo", propagateEvents: true, beforeEnter: () => showResults() },
        ],
        dialogClass: "organiser-demo-tour-dialog",
        backdropClass: "organiser-demo-tour-backdrop",
        closeButton: false,
        nextLabel: "Next",
        finishLabel: "Finish demo",
        hidePrev: true,
        showStepProgress: true,
        keyboardControls: false,
        activeStepInteraction: true,
        completeOnFinish: false,
      });
      const syncControls = () => {
        const isFinalStep = tour.activeStep === tour.tourSteps.length - 1;
        const nextButton = tour.dialog.querySelector<HTMLElement>("#tg-dialog-next-btn");
        if (nextButton) {
          nextButton.style.display = isFinalStep ? "" : "none";
        }
      };
      const handleAction = (event: MouseEvent) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) {
          return;
        }
        const action = target.closest<HTMLElement>("[data-demo-action]")?.dataset.demoAction;
        if (
          (tour.activeStep === 1 && action === "general-invite")
          || (tour.activeStep === 3 && action === "resident-import")
        ) {
          void tour.nextStep();
        }
      };
      tour.onAfterExit(() => {
        if (tourRef.current === tour) {
          tourRef.current = null;
        }
        document.removeEventListener("click", handleAction);
        onExit();
      });
      tour.onAfterStepChange(syncControls);
      tourRef.current = tour;
      void tour.start("organiser-demo").then(() => {
        const skipButton = document.createElement("button");
        skipButton.type = "button";
        skipButton.className = "organiser-demo-tour-skip";
        skipButton.textContent = "Skip demo";
        skipButton.addEventListener("click", () => void tour.exit());
        tour.dialog.querySelector(".tg-dialog-footer")?.append(skipButton);
        document.addEventListener("click", handleAction);
        syncControls();
      });
    }, 100);
  }

  function afterNextPaint(action: () => void) {
    action();
    return new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
    });
  }

  function showVoters() {
    return afterNextPaint(onShowVoters);
  }

  function showResults() {
    return afterNextPaint(onShowResults);
  }

  return (
    <>
      {showLauncher ? (
        <div className='simple-organiser-demo-launcher'>
          <UiButton icon='book' className='simple-voter-secondary' onPress={() => setConfirmOpen(true)}>
            Start demo
          </UiButton>
        </div>
      ) : null}
      {confirmOpen ? (
        <div className='simple-identity-qr-overlay simple-new-identity-confirm-overlay' role='dialog' aria-modal='true' aria-labelledby='demo-confirm-title'>
          <div className='simple-identity-qr-overlay-card simple-new-identity-confirm-card'>
            <h2 id='demo-confirm-title' className='simple-voter-section-title'>Publish a real demo?</h2>
            <p className='simple-voter-note'>This will prepare a demonstration questionnaire and guide you to publish it to Nostr using your organiser identity.</p>
            <div className='simple-new-identity-confirm-actions'>
              <UiButton icon='cancel' className='simple-voter-secondary' onPress={() => setConfirmOpen(false)}>Cancel</UiButton>
              <UiButton icon='check' className='simple-voter-primary' onPress={() => {
                setConfirmOpen(false);
                startTour();
              }}>Start demo</UiButton>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
