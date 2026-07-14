import { useApiConfig } from "./api/useApiConfig";
import { HealthBanner } from "./components/HealthBanner";
import { SettingsBar } from "./components/SettingsBar";
import { RecommendationForm } from "./components/RecommendationForm";
import { AssessmentForm } from "./components/AssessmentForm";
import { ReportPanel } from "./components/ReportPanel";
import "./App.css";

export default function App() {
  const { config, setConfig } = useApiConfig();

  return (
    <div className="app">
      <header>
        <h1>AI Gateway — Instructor Dashboard</h1>
        <HealthBanner config={config} />
      </header>

      <SettingsBar config={config} onChange={setConfig} />

      <main>
        <RecommendationForm config={config} />
        <AssessmentForm config={config} />
        <ReportPanel config={config} />
      </main>
    </div>
  );
}
