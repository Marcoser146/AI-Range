import type { ApiConfig } from "../api/client";

interface Props {
  config: ApiConfig;
  onChange: (config: ApiConfig) => void;
}

export function SettingsBar({ config, onChange }: Props) {
  return (
    <div className="panel settings-bar">
      <label>
        Gateway URL
        <input
          type="text"
          value={config.baseUrl}
          onChange={(e) => onChange({ ...config, baseUrl: e.target.value })}
          placeholder="/v1"
        />
      </label>
      <label>
        API key
        <input
          type="password"
          value={config.apiKey}
          onChange={(e) => onChange({ ...config, apiKey: e.target.value })}
          placeholder="AI_GATEWAY_API_KEY"
        />
      </label>
    </div>
  );
}
