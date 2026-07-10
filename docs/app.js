const storageKey = "dyb-counseling-gemini-pwa-v1";
const geminiBaseUrl = "https://generativelanguage.googleapis.com/v1beta/models";
const maxTranscriptChars = 24000;
const maxExampleCount = 3;
const maxExampleChars = 1200;
const appVersion = 7;

const defaultSettings = {
  mode: "mock",
  theme: "system",
  recipientEmail: "",
  geminiApiKey: "",
  lengthTolerancePercent: 20,
  styleMemo: "상담일지에 바로 붙여 넣을 수 있도록 차분하고 구체적인 문장으로 작성",
  referenceExamples: []
};

const fixedGeminiModel = "gemini-2.5-flash";
const $ = (id) => document.getElementById(id);

let settings = loadSettings();
applyTheme(settings.theme);
window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
  if (settings.theme === "system") applyTheme("system");
});
let latest = {
  sourceName: "",
  transcript: "",
  summary: "",
  requestSignature: ""
};

$("appVersionLabel").textContent = `v${appVersion}`;
let isLoading = false;
let editingExampleId = null;

const views = {
  home: $("homeView"),
  settings: $("settingsView"),
  examples: $("examplesView")
};

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
    const nextSettings = {
      ...defaultSettings,
      ...saved,
      referenceExamples: Array.isArray(saved.referenceExamples) ? saved.referenceExamples : []
    };
    delete nextSettings.geminiModel;
    delete nextSettings.summaryLength;
    if (![10, 20, 30, 40, 50].includes(Number(nextSettings.lengthTolerancePercent))) {
      nextSettings.lengthTolerancePercent = 20;
    }
    if (!["system", "light", "dark"].includes(nextSettings.theme)) {
      nextSettings.theme = "system";
    }
    return nextSettings;
  } catch {
    localStorage.removeItem(storageKey);
    return { ...defaultSettings };
  }
}

function persistSettings() {
  localStorage.setItem(storageKey, JSON.stringify(settings));
}

function applyTheme(theme) {
  const nextTheme = ["system", "light", "dark"].includes(theme) ? theme : "system";
  document.documentElement.dataset.theme = nextTheme;
  const isDark = nextTheme === "dark" || (nextTheme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const themeColor = isDark ? "#24262d" : "#ffffff";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeColor);
}

function showView(name) {
  Object.entries(views).forEach(([key, view]) => {
    view.classList.toggle("hidden", key !== name);
  });
  updateTabState(name);
  clearError();
}

function updateTabState(name) {
  $("summaryTabButton").classList.toggle("active", name === "home" || name === "settings");
  $("sampleTabButton").classList.toggle("active", name === "examples");
}

let progressTimer = null;

function showStatus(title, detail, percent = 0) {
  $("statusTitle").textContent = title;
  $("statusDetail").textContent = detail;
  updateProgress(percent);
  $("statusBox").classList.remove("hidden");
}

function hideStatus() {
  stopProgressTimer();
  $("statusBox").classList.add("hidden");
}

function updateProgress(percent) {
  const nextPercent = Math.max(0, Math.min(100, Math.round(percent)));
  $("progressPercent").textContent = `${nextPercent}%`;
  $("progressBar").style.width = `${nextPercent}%`;
}

function startProgressTimer(start = 35, end = 85) {
  stopProgressTimer();
  let current = start;
  updateProgress(current);
  progressTimer = window.setInterval(() => {
    current = Math.min(end, current + Math.max(1, Math.round((end - current) / 8)));
    updateProgress(current);
    if (current >= end) stopProgressTimer();
  }, 900);
}

function stopProgressTimer() {
  if (progressTimer) {
    window.clearInterval(progressTimer);
    progressTimer = null;
  }
}

function showError(message) {
  $("errorMessage").textContent = message;
  $("errorMessage").classList.remove("hidden");
}

function clearError() {
  $("errorMessage").textContent = "";
  $("errorMessage").classList.add("hidden");
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.add("hidden"), 2200);
}

function makeId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // iPhone LAN HTTP testing can block Clipboard API. Use the textarea fallback.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function setLoading(nextValue) {
  isLoading = nextValue;
  $("summarizeButton").disabled = nextValue;
  $("resummarizeButton").disabled = nextValue;
  $("summarizeButton").textContent = nextValue ? "요약 중..." : "요약하기";
}

function updateInputInfo() {
  const length = $("transcriptInput").value.trim().length;
  $("inputInfo").textContent = length ? `${length.toLocaleString()}자 입력됨` : "입력된 상담 내용 없음";
}

async function readTextFile(file) {
  const lowerName = file.name.toLowerCase();
  const isText = file.type === "text/plain" || lowerName.endsWith(".txt");
  if (!isText) {
    throw new Error("txt 텍스트 파일만 선택할 수 있습니다.");
  }

  const text = (await file.text()).trim();
  if (!text) {
    throw new Error("파일에 읽을 수 있는 텍스트가 없습니다.");
  }
  return text;
}

function compactTranscript(text) {
  const trimmed = text.trim();
  if (trimmed.length <= maxTranscriptChars) {
    return { text: trimmed, wasCompacted: false };
  }

  const front = trimmed.slice(0, 10000);
  const middleStart = Math.max(0, Math.floor(trimmed.length / 2) - 2000);
  const middle = trimmed.slice(middleStart, middleStart + 4000);
  const end = trimmed.slice(-10000);
  return {
    text: [
      "[긴 상담 내용이라 무료 티어 사용량 절약을 위해 앞부분, 중간 핵심 구간, 끝부분 중심으로 압축했습니다.]",
      "[앞부분]",
      front,
      "[중간]",
      middle,
      "[끝부분]",
      end
    ].join("\n\n"),
    wasCompacted: true
  };
}

function limitedExamples() {
  return settings.referenceExamples
    .slice()
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
    .slice(0, maxExampleCount)
    .map((example, index) => `예시 ${index + 1} - ${example.title || "제목 없음"}\n${example.body.slice(0, maxExampleChars)}`);
}

function averageReferenceLength() {
  if (!settings.referenceExamples.length) return null;
  const total = settings.referenceExamples.reduce((sum, example) => sum + example.body.length, 0);
  return Math.round(total / settings.referenceExamples.length);
}

function summaryLengthGuide() {
  const average = averageReferenceLength();
  if (!average) {
    return "참고 예시가 없으므로 상담 내용에 맞는 자연스러운 분량";
  }

  const tolerance = Number(settings.lengthTolerancePercent) || 20;
  const ratio = tolerance / 100;
  const min = Math.max(1, Math.round(average * (1 - ratio)));
  const max = Math.round(average * (1 + ratio));
  return `${min}~${max}자 (예시 평균 ${average}자, 하한 -${tolerance}% / 상한 +${tolerance}%)`;
}

function normalizeMemoStyle(summary) {
  const lines = summary
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) return summary.trim();

  const firstLine = normalizeSummaryHeader(lines[0]);

  const bodyLines = (lines[0].startsWith("[") ? lines.slice(1) : lines)
    .map((line) => line.replace(/^[-•]\s*/, ""))
    .map(normalizeCounselingTone)
    .filter(Boolean)
    .map((line) => `- ${line}`);

  return [firstLine, ...bodyLines].join("\n");
}

function normalizeCounselingTone(line) {
  return line
    .replace(/([가-힣]{2,4})\s*학생/g, (_, name) => name.endsWith("이") ? name : `${name}이`)
    .replace(/우려를\s*표명하였으며/g, "걱정하셨으며")
    .replace(/우려\s*표명하였으며/g, "걱정하셨으며")
    .replace(/우려를\s*표명하였음/g, "걱정하셨음")
    .replace(/우려\s*표명하였음/g, "걱정하셨음")
    .replace(/우려를\s*나타냈으며/g, "걱정하셨으며")
    .replace(/우려를\s*나타냄/g, "걱정하셨음")
    .replace(/우려하였으며/g, "걱정하셨으며")
    .replace(/우려하였음/g, "걱정하셨음")
    .replace(/요청사항을\s*전달하였으며/g, "요청사항을 말씀주셨으며")
    .replace(/의견을\s*제시하였으며/g, "의견을 말씀주셨으며")
    .replace(/질의하였으며/g, "질문주셨으며")
    .replace(/문의하였으며/g, "문의주셨으며")
    .replace(/확인을\s*요청하였으며/g, "확인을 요청주셨으며")
    .replace(/필요성을\s*강조하였으며/g, "필요함을 함께 확인드렸으며")
    .replace(/지도\s*방안을\s*제시하였으며/g, "지도 방향을 안내드렸으며")
    .replace(/학습\s*상태를\s*공유하였으며/g, "학습 상태를 공유드렸으며")
    .replace(/표명하였으며/g, "말씀주셨으며")
    .replace(/표명하였음/g, "말씀주셨음")
    .replace(/제시하였으며/g, "말씀드렸으며")
    .replace(/제시하였음/g, "말씀드림")
    .replace(/요구하였으며/g, "요청주셨으며")
    .replace(/요구하였음/g, "요청주셨음")
    .replace(/개선이\s*요구됨/g, "개선이 필요함")
    .replace(/관찰됨/g, "확인됨")
    .replace(/확인되었고/g, "확인드렸고")
    .replace(/확인되었으며/g, "확인드렸으며")
    .replace(/하였습니다/g, "하였음")
    .replace(/했습니다/g, "하였음")
    .replace(/합니다/g, "함")
    .replace(/됩니다/g, "됨")
    .replace(/입니다/g, "임")
    .replace(/했다/g, "하였음")
    .replace(/하였다/g, "하였음")
    .replace(/안내되었으며/g, "안내드렸으며")
    .replace(/설명되었으며/g, "설명드렸으며")
    .replace(/논의되었으며/g, "논의드렸으며")
    .replace(/언급되었으며/g, "언급드렸으며")
    .replace(/공유되었으며/g, "공유드렸으며")
    .replace(/전달되었으며/g, "전달드렸으며")
    .replace(/확인되었으며/g, "확인드렸으며")
    .replace(/요청되었으며/g, "요청드렸으며")
    .replace(/안내되었음/g, "안내드림")
    .replace(/설명되었음/g, "설명드림")
    .replace(/논의되었음/g, "논의드림")
    .replace(/언급되었음/g, "언급드림")
    .replace(/공유되었음/g, "공유드림")
    .replace(/전달되었음/g, "전달드림")
    .replace(/확인되었음/g, "확인드림")
    .replace(/요청되었음/g, "요청드림")
    .replace(/안내하였음/g, "안내드림")
    .replace(/안내함/g, "안내드림")
    .replace(/안내됨/g, "안내드림")
    .replace(/설명하였음/g, "설명드림")
    .replace(/설명함/g, "설명드림")
    .replace(/설명됨/g, "설명드림")
    .replace(/논의하였음/g, "논의드림")
    .replace(/논의함/g, "논의드림")
    .replace(/논의됨/g, "논의드림")
    .replace(/언급하였음/g, "언급드림")
    .replace(/언급함/g, "언급드림")
    .replace(/언급됨/g, "언급드림")
    .replace(/공유하였음/g, "공유드림")
    .replace(/공유함/g, "공유드림")
    .replace(/공유됨/g, "공유드림")
    .replace(/말씀하였음/g, "말씀드림")
    .replace(/말씀함/g, "말씀드림")
    .replace(/전달하였음/g, "전달드림")
    .replace(/전달함/g, "전달드림")
    .replace(/전달됨/g, "전달드림")
    .replace(/확인하였음/g, "확인드림")
    .replace(/확인함/g, "확인드림")
    .replace(/요청하였음/g, "요청드림")
    .replace(/요청함/g, "요청드림")
    .replace(/필요함이\s+설명드림/g, "필요함을 설명드림")
    .replace(/필요함이\s+안내드림/g, "필요함을 안내드림")
    .replace(/필요함이\s+언급드림/g, "필요함을 언급드림")
    .replace(/필요함이\s+공유드림/g, "필요함을 공유드림")
    .replace(/필요함이\s+전달드림/g, "필요함을 전달드림")
    .replace(/([가-힣]+(?:함|됨))이\s+(설명|안내|언급|공유|전달|확인|요청|논의)드림/g, "$1을 $2드림")
    .replace(/[.。]/g, "")
    .trim();
}

function normalizeSummaryHeader(line) {
  const cleanLine = line.replace(/[.。]/g, "").trim();
  const bracketMatch = cleanLine.match(/^\[([^\]:]+:)?\s*([^\]]+)\]/);
  if (bracketMatch) {
    const summary = normalizeHeaderTopic(bracketMatch[2]);
    return `[${summary}]`;
  }

  const fallback = normalizeHeaderTopic(cleanLine.replace(/^[-•]\s*/, ""));
  return `[${fallback}]`;
}

function normalizeHeaderTopic(text) {
  const topic = text
    .replace(/상담$/g, "상담")
    .replace(/에 대한 상담/g, " 상담")
    .replace(/관련 상담/g, "상담")
    .replace(/방향에 대한/g, "방향")
    .replace(/하였음/g, "")
    .replace(/하였으며/g, "")
    .replace(/입니다/g, "")
    .replace(/임/g, "")
    .replace(/[.。]/g, "")
    .trim();

  return (topic || "상담내용 요약").slice(0, 20);
}

function buildPrompt(transcript) {
  const examples = limitedExamples();
  return [
    "너는 학원 상담 내용을 정리하는 전문 비서다. 아래 내용은 학원 선생님과 학부모 간 상담 대화이다. 사용자가 저장한 기존 상담요약 예시의 문체, 분량, 표현 방식을 참고해 실제 상담일지에 바로 붙여 넣을 수 있는 자연스러운 요약문을 작성해라. 불필요한 카테고리 분류는 하지 말고, 통화 내용에 근거해서만 간결하게 정리해라. 사용자가 지정한 분량에 맞춰 작성해라.",
    "",
    "[출력 형식]",
    "첫 줄은 반드시 [요약 20자 이내] 형식으로 작성해라. 학생 이름은 헤더에 넣지 마라. 문장형으로 쓰지 말고 핵심 주제만 명사형으로 짧게 작성해라. 예: [학습습관 점검], [과제수행 관리], [가정학습 방향]",
    "본문의 각 문장 또는 의미 단위는 줄마다 '- '로 시작해라.",
    "문장 끝에는 마침표를 찍지 마라.",
    "'했다' 대신 '하였음', '하였다' 대신 '하였음', '입니다' 대신 '임', '했습니다' 대신 '하였음', '됩니다' 대신 '됨'처럼 상담일지 메모체로 작성해라.",
    "학생 이름 뒤에 '학생'을 절대 붙이지 마라. 예를 들어 이름이 지원이면 '지원학생'이라고 쓰지 말고 반드시 '지원이'처럼 자연스럽게 표현해라. 미연이면 '미연학생'이 아니라 '미연이'처럼 표현해라. 이름을 아는 경우 '학생'으로 표현하는 예외는 만들지 마라.",
    "요약에는 어려운 행정 용어나 보고서식 단어를 쓰지 말고, 실제 대화에 나온 수준의 쉬운 일상 표현을 사용해라. 원문보다 과하게 전문적인 말로 바꾸지 마라.",
    "학부모 상담 내역에 맞게 너무 딱딱하지 않은 존중 표현을 사용해라. 예: 설명함이 아니라 설명드림, 논의함이 아니라 논의드림, 언급됨이 아니라 언급드림, 언급되었으며가 아니라 언급드렸으며, 안내함이 아니라 안내드림.",
    "행정문서나 보고서 같은 표현은 피하고 학부모님께 공유하는 자연스러운 상담 메모체로 작성해라. 예: 우려 표명하였으며가 아니라 걱정하셨으며, 질의하였으며가 아니라 질문주셨으며, 의견을 제시하였으며가 아니라 의견을 말씀주셨으며.",
    "조사가 어색하지 않게 작성해라. 예: 필요함이 설명드림이 아니라 필요함을 설명드림.",
    "전체를 명사형/메모체 종결로 통일하되 학부모에게 공유하는 상담 내역처럼 부드럽게 작성해라.",
    "",
    `[원하는 요약 분량]\n${summaryLengthGuide()}`,
    "",
    `[요약 스타일 메모]\n${settings.styleMemo || "없음"}`,
    "",
    `[참고 요약 예시]\n${examples.length ? examples.join("\n\n---\n\n") : "저장된 참고 예시 없음"}`,
    "",
    `[상담 원문]\n${transcript}`,
    "",
    "요약문만 출력해라. 분석 과정은 쓰지 마라. 위 출력 형식을 어기지 마라."
  ].join("\n");
}

function requestSignature(transcript) {
  return JSON.stringify({
    mode: settings.mode,
    model: fixedGeminiModel,
    length: summaryLengthGuide(),
    style: settings.styleMemo,
    examples: limitedExamples(),
    transcript
  });
}

async function summarizeCurrentInput({ force = false } = {}) {
  if (isLoading) return;

  const transcript = $("transcriptInput").value.trim();
  if (!transcript) {
    showError("상담 텍스트 파일을 선택하거나 상담 내용을 직접 붙여넣어 주세요.");
    return;
  }

  if (settings.mode === "gemini" && !settings.geminiApiKey.trim()) {
    showError("Gemini 모드를 사용하려면 설정에서 Gemini API 키를 입력해 주세요.");
    return;
  }

  const compacted = compactTranscript(transcript);
  const signature = requestSignature(compacted.text);
  if (!force && latest.summary && latest.requestSignature === signature) {
    showToast("같은 내용의 요약 결과가 이미 있습니다.");
    $("resultView").classList.remove("hidden");
    return;
  }

  clearError();
  setLoading(true);
  showStatus(
    settings.mode === "mock" ? "Mock 요약 중" : "Gemini 요약 중",
    compacted.wasCompacted ? "긴 상담 내용을 앞/중간/끝 중심으로 줄여 요청합니다." : "상담 내용을 분석하고 있습니다.",
    8
  );

  try {
    showStatus("요약 준비 중", "프롬프트와 참고 예시를 정리하고 있습니다.", 18);
    const rawSummary = settings.mode === "mock"
      ? await mockSummarize(compacted.text)
      : await geminiSummarize(compacted.text, ({ title, detail, percent, auto = false }) => {
        showStatus(title, detail, percent);
        if (auto) startProgressTimer(percent, 86);
      });
    showStatus("요약 정리 중", "상담일지 말투와 형식을 다듬고 있습니다.", 92);
    const summary = normalizeMemoStyle(rawSummary);

    latest = {
      sourceName: latest.sourceName || "직접 입력 상담",
      transcript,
      summary,
      requestSignature: signature
    };
    $("summaryOutput").value = summary;
    $("resultSource").textContent = `${latest.sourceName} · ${settings.mode === "mock" ? "Mock" : "Gemini"}`;
    updateProgress(100);
    hideStatus();
    $("resultView").classList.remove("hidden");
  } catch (error) {
    hideStatus();
    showError(error.message || "요약 중 오류가 발생했습니다.");
  } finally {
    setLoading(false);
  }
}

async function mockSummarize(transcript) {
  updateProgress(55);
  await new Promise((resolve) => window.setTimeout(resolve, 650));
  updateProgress(86);
  const note = settings.referenceExamples.length
    ? `저장된 참고 예시 ${Math.min(settings.referenceExamples.length, maxExampleCount)}개를 페르소나로 참고한 Mock 결과입니다.`
    : "저장된 참고 예시가 없어 기본 상담일지 문체로 작성한 Mock 결과입니다.";

  return `[학습습관 점검]\n- 학부모님은 학생이 가정에서 학습 시작까지 시간이 걸리고 과제와 복습을 꾸준히 이어가는 부분을 걱정하였음\n- 상담 내용상 학생은 수업 설명을 이해하는 흐름은 유지하고 있으나 문제 조건 확인과 문장 정리 과정에서 실수가 있는 편임\n- 선생님은 기본기가 크게 흔들린 상태라기보다 풀이 습관과 반복 점검이 필요한 단계라고 안내드림\n- 수업에서는 오답 이유를 학생이 직접 말로 설명하도록 돕고 짧은 단위의 단어 확인과 서술형 문장 연습을 병행하기로 논의드림\n- 가정에서는 정답을 바로 알려주기보다 아이가 먼저 근거를 말하도록 기다려 주고 정해진 시간에 시작하고 마무리하는 습관을 우선 확인해 달라고 안내드림\n- 다음 수업 전까지 단어 범위를 나누어 점검하고 오답 설명 과정을 함께 확인하기로 공유드림\n- ${note.replaceAll(".", "")} 희망 분량: ${summaryLengthGuide()}`;
}

async function geminiSummarize(transcript, onProgress = () => {}) {
  onProgress({ title: "Gemini 요약 준비 중", detail: "상담 원문과 샘플 페르소나를 구성하고 있습니다.", percent: 25 });
  const prompt = buildPrompt(transcript);
  const model = encodeURIComponent(fixedGeminiModel);
  const key = encodeURIComponent(settings.geminiApiKey.trim());
  let response;

  try {
    onProgress({ title: "Gemini 전송 중", detail: "Gemini API로 요약 요청을 보내고 있습니다.", percent: 38 });
    onProgress({ title: "Gemini 분석 중", detail: "응답 생성이 끝날 때까지 대기 중입니다.", percent: 45, auto: true });
    response = await fetch(`${geminiBaseUrl}/${model}:generateContent?key=${key}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            { text: "너는 한국어 상담일지 작성에 능숙한 학원 상담요약 비서다." }
          ]
        },
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          temperature: 0.35
        }
      })
    });
    stopProgressTimer();
    onProgress({ title: "Gemini 응답 확인 중", detail: "응답을 받아 오류 여부를 확인하고 있습니다.", percent: 86 });
  } catch (error) {
    throw new Error("Gemini 요청을 보낼 수 없습니다. 토큰 부족보다는 네트워크, Safari CORS 차단, API 키의 HTTP referrer 제한 가능성이 큽니다. 로컬 HTTP에서 계속 실패하면 HTTPS 배포 또는 백엔드 프록시가 필요합니다.");
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw geminiError(response.status, data);
  }

  onProgress({ title: "요약 추출 중", detail: "Gemini 응답에서 요약문을 추출하고 있습니다.", percent: 88 });
  const text = extractGeminiText(data);
  if (!text) {
    throw new Error("Gemini가 요약 결과를 반환하지 않았습니다.");
  }
  return text;
}

function extractGeminiText(data) {
  if (typeof data.output_text === "string") return data.output_text.trim();

  const texts = [];
  for (const step of data.steps || []) {
    for (const part of step.content || step.contents || []) {
      if (typeof part.text === "string") texts.push(part.text);
    }
  }
  for (const candidate of data.candidates || []) {
    for (const part of candidate.content?.parts || []) {
      if (typeof part.text === "string") texts.push(part.text);
    }
  }
  return texts.join("\n").trim();
}

function geminiError(status, data) {
  const message = data.error?.message || data.message || "";
  const lowerMessage = message.toLowerCase();
  const tokenLikely = /token|tokens|context|too long|input size|maximum|exceed|초과|길이|너무 깁/.test(lowerMessage);

  if (tokenLikely) {
    return new Error(`Gemini 토큰/입력 길이 문제일 가능성이 큽니다. 상담 원문이 너무 길거나 샘플 예시가 많아 한 번에 처리 가능한 길이를 넘었을 수 있습니다. 원문을 줄이거나 샘플 예시 수/길이를 줄인 뒤 다시 시도해 주세요. 원문 상세: ${message || "토큰 한도 관련 오류"}`);
  }
  if (status === 400) return new Error(`Gemini 요청 형식 또는 입력값 문제입니다. 토큰 부족으로 단정되지는 않습니다. 모델명, API 키, 입력 텍스트를 확인해 주세요. 원문 상세: ${message}`);
  if (status === 401 || status === 403) return new Error(`Gemini API 키 권한 문제입니다. 토큰 부족이 아니라 API 키가 잘못됐거나, referrer 제한/권한 설정에 막혔을 가능성이 큽니다. 원문 상세: ${message}`);
  if (status === 429) return new Error(`Gemini 무료 티어 한도 또는 분당 요청 한도 초과입니다. 토큰 부족이라기보다 사용량 제한에 걸린 상태일 가능성이 큽니다. 잠시 후 다시 시도해 주세요. 원문 상세: ${message}`);
  if (status >= 500) return new Error(`Gemini 서버 오류입니다. 토큰 부족보다는 Gemini 서버 또는 일시적 모델 응답 문제일 가능성이 큽니다. 잠시 후 다시 시도해 주세요. 원문 상세: ${message}`);
  return new Error(`Gemini API 오류(${status})입니다. 토큰 문제 여부는 명확하지 않습니다. 원문 상세: ${message || "알 수 없는 오류"}`);
}

function renderSettings() {
  $("themeSelect").value = settings.theme;
  $("modeSelect").value = settings.mode;
  $("recipientEmailInput").value = settings.recipientEmail;
  $("geminiApiKeyInput").value = settings.geminiApiKey;
  $("geminiModelLabel").textContent = fixedGeminiModel;
  $("lengthToleranceSelect").value = String(settings.lengthTolerancePercent);
  $("averageLengthLabel").textContent = averageReferenceLength()
    ? `${averageReferenceLength().toLocaleString()}자`
    : "저장된 예시 없음";
  $("summaryLengthGuide").textContent = summaryLengthGuide();
  $("styleMemoInput").value = settings.styleMemo;
}

function saveSettingsFromForm() {
  settings = {
    ...settings,
    theme: $("themeSelect").value,
    mode: $("modeSelect").value,
    recipientEmail: $("recipientEmailInput").value.trim(),
    geminiApiKey: $("geminiApiKeyInput").value.trim(),
    lengthTolerancePercent: Number($("lengthToleranceSelect").value) || 20,
    styleMemo: $("styleMemoInput").value.trim()
  };
  applyTheme(settings.theme);
  persistSettings();
  showToast("설정을 저장했습니다.");
}

function renderExamples() {
  const list = $("examplesList");
  list.innerHTML = "";

  if (!settings.referenceExamples.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "저장된 참고 예시가 없습니다.";
    list.append(empty);
    return;
  }

  settings.referenceExamples
    .slice()
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
    .forEach((example) => {
      const item = document.createElement("article");
      item.className = "example-item";

      const title = document.createElement("h3");
      title.textContent = example.title || "제목 없는 예시";

      const body = document.createElement("p");
      body.textContent = example.body;

      const meta = document.createElement("p");
      meta.className = "hint";
      meta.textContent = `${example.body.length.toLocaleString()}자`;

      const actions = document.createElement("div");
      actions.className = "example-actions";

      const editButton = document.createElement("button");
      editButton.className = "secondary-button";
      editButton.type = "button";
      editButton.textContent = "수정";
      editButton.addEventListener("click", () => openExampleDialog(example.id));

      const deleteButton = document.createElement("button");
      deleteButton.className = "secondary-button";
      deleteButton.type = "button";
      deleteButton.textContent = "삭제";
      deleteButton.addEventListener("click", () => {
        settings.referenceExamples = settings.referenceExamples.filter((candidate) => candidate.id !== example.id);
        persistSettings();
        renderExamples();
        renderSettings();
        showToast("예시를 삭제했습니다.");
      });

      actions.append(editButton, deleteButton);
      item.append(title, body, meta, actions);
      list.append(item);
    });
}

function openExampleDialog(id = null) {
  editingExampleId = id;
  const example = settings.referenceExamples.find((candidate) => candidate.id === id);
  $("exampleDialogTitle").textContent = example ? "예시 수정" : "예시 추가";
  $("exampleTitleInput").value = example?.title || "";
  $("exampleBodyInput").value = example?.body || "";
  $("exampleDialog").showModal();
}

function saveExample() {
  const title = $("exampleTitleInput").value.trim() || "제목 없는 예시";
  const body = $("exampleBodyInput").value.trim();
  if (!body) {
    showToast("상담요약 예시를 입력해 주세요.");
    return;
  }

  const nextExample = {
    id: editingExampleId || makeId(),
    title,
    body,
    updatedAt: new Date().toISOString()
  };

  if (editingExampleId) {
    settings.referenceExamples = settings.referenceExamples.map((example) =>
      example.id === editingExampleId ? nextExample : example
    );
  } else {
    settings.referenceExamples = [nextExample, ...settings.referenceExamples];
  }

  persistSettings();
  renderExamples();
  renderSettings();
  $("exampleDialog").close();
  showToast("예시를 저장했습니다.");
}

function currentSummaryText() {
  return $("summaryOutput").value.trim();
}

function saveCurrentSummaryAsStyle() {
  const body = currentSummaryText();
  if (!body) {
    showToast("저장할 요약문이 없습니다.");
    return;
  }

  const duplicate = settings.referenceExamples.some((example) => example.body.trim() === body);
  if (duplicate) {
    showToast("이미 저장된 스타일 예시입니다.");
    return;
  }

  const titleSource = body.match(/^\[([^\]]+)\]/)?.[1] || latest.sourceName || "수정 요약";
  const nextExample = {
    id: makeId(),
    title: `내 스타일 · ${titleSource}`.slice(0, 40),
    body,
    updatedAt: new Date().toISOString()
  };

  settings.referenceExamples = [nextExample, ...settings.referenceExamples];
  persistSettings();
  renderExamples();
  renderSettings();
  showToast("내 스타일 예시로 저장했습니다.");
}

function formattedTimestamp(date = new Date()) {
  const two = (value) => String(value).padStart(2, "0");
  return `${two(date.getFullYear() % 100)}${two(date.getMonth() + 1)}${two(date.getDate())} - ${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

async function sendMail() {
  const studentName = $("studentNameInput").value.trim();
  if (!studentName) {
    showToast("학생 이름을 입력해 주세요.");
    return;
  }

  const subject = `DYB상담내역 ${studentName} ${formattedTimestamp()}`;
  const body = currentSummaryText() || latest.summary;
  const recipient = settings.recipientEmail.trim();
  if (!recipient) {
    await copyText(body);
    $("studentDialog").close();
    showToast("수신 이메일이 없어 요약 본문을 복사했습니다.");
    return;
  }

  window.location.href = `mailto:${encodeURIComponent(recipient)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  $("studentDialog").close();
}

function bindEvents() {
  $("openSettingsButton").addEventListener("click", () => {
    renderSettings();
    showView("settings");
  });
  $("summaryTabButton").addEventListener("click", () => {
    showView("home");
  });
  $("sampleTabButton").addEventListener("click", () => {
    renderExamples();
    showView("examples");
  });
  document.querySelectorAll("[data-show-home]").forEach((button) => {
    button.addEventListener("click", () => showView("home"));
  });

  $("fileInput").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
      showStatus("파일 읽는 중", "선택한 txt 파일을 불러오고 있습니다.");
      latest.sourceName = file.name;
      $("transcriptInput").value = await readTextFile(file);
      latest.summary = "";
      $("resultView").classList.add("hidden");
      updateInputInfo();
      hideStatus();
      showToast("파일 내용을 불러왔습니다.");
    } catch (error) {
      hideStatus();
      showError(error.message);
    }
  });

  $("transcriptInput").addEventListener("input", () => {
    latest.sourceName = "직접 입력 상담";
    latest.summary = "";
    $("resultView").classList.add("hidden");
    updateInputInfo();
  });
  $("summarizeButton").addEventListener("click", () => summarizeCurrentInput());
  $("resummarizeButton").addEventListener("click", () => summarizeCurrentInput({ force: true }));
  $("copySummaryButton").addEventListener("click", async () => {
    await copyText(currentSummaryText() || latest.summary);
    showToast("요약 결과를 복사했습니다.");
  });
  $("saveStyleButton").addEventListener("click", saveCurrentSummaryAsStyle);
  $("summaryOutput").addEventListener("input", () => {
    latest.summary = $("summaryOutput").value;
  });
  $("emailSummaryButton").addEventListener("click", () => {
    $("studentNameInput").value = "";
    $("studentDialog").showModal();
  });

  $("saveSettingsButton").addEventListener("click", saveSettingsFromForm);
  $("themeSelect").addEventListener("change", () => {
    settings.theme = $("themeSelect").value;
    applyTheme(settings.theme);
    persistSettings();
  });
  $("modeSelect").addEventListener("change", () => {
    settings.mode = $("modeSelect").value;
    persistSettings();
  });
  $("addExampleButton").addEventListener("click", () => openExampleDialog());
  $("lengthToleranceSelect").addEventListener("change", () => {
    settings.lengthTolerancePercent = Number($("lengthToleranceSelect").value) || 20;
    persistSettings();
    renderSettings();
  });
  $("exampleFileInput").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
      const body = await readTextFile(file);
      settings.referenceExamples = [{
        id: makeId(),
        title: file.name,
        body,
        updatedAt: new Date().toISOString()
      }, ...settings.referenceExamples];
      persistSettings();
      renderExamples();
      renderSettings();
      showToast("텍스트 예시를 저장했습니다.");
    } catch (error) {
      showToast(error.message || "텍스트 예시를 저장하지 못했습니다.");
    }
  });
  $("saveExampleButton").addEventListener("click", saveExample);
  $("sendMailButton").addEventListener("click", sendMail);
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./service-worker.js").catch(() => {});
}

bindEvents();
renderSettings();
renderExamples();
updateInputInfo();
updateTabState("home");
