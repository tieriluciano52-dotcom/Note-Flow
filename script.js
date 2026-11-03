const $ = id => document.getElementById(id);

const fileInput = $("fileInput");
const dropZone = $("dropZone");
const audioPlayer = $("audioPlayer");
const videoPlayer = $("videoPlayer");
const workspace = $("workspace");

let currentMedia = null;
let currentObjectUrl = null;
let audioContext = null;
let analyser = null;
let sourceNode = null;
let animationTimer = null;
let analysisBuffer = null;

let lastCandidateMidi = null;
let candidateSince = 0;
let activeMidi = null;
let activeSegment = null;
let lastDetectedTime = 0;
let lastRenderTime = 0;
let historyEntries = [];
let sequenceEntries = [];

let settings = {
    theme: "light",
    sensitivity: "medium",
    stability: 280,
    update: 70,
    notation: "sharp",
    showFrequency: true
};

const sharpNames = [
    "DO", "DO♯", "RE", "RE♯", "MI", "FA",
    "FA♯", "SOL", "SOL♯", "LA", "LA♯", "SI"
];

const flatNames = [
    "DO", "RE♭", "RE", "MI♭", "MI", "FA",
    "SOL♭", "SOL", "LA♭", "LA", "SI♭", "SI"
];

function getNoteName(midi) {
    const names = settings.notation === "flat" ? flatNames : sharpNames;
    const note = names[((midi % 12) + 12) % 12];
    const octave = Math.floor(midi / 12) - 1;
    return `${note}${octave}`;
}

function getNoteLabel(midi) {
    const names = settings.notation === "flat" ? flatNames : sharpNames;
    return names[((midi % 12) + 12) % 12];
}

function midiToFrequency(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
}

function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return "0:00";

    const minutes = Math.floor(seconds / 60);
    const remaining = Math.floor(seconds % 60);

    return `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function showToast(message) {
    const toast = $("toast");
    toast.textContent = message;
    toast.classList.add("show");

    clearTimeout(showToast.timer);

    showToast.timer = setTimeout(() => {
        toast.classList.remove("show");
    }, 2500);
}

function loadSettings() {
    try {
        const saved = JSON.parse(localStorage.getItem("noteflow-settings"));

        if (saved && typeof saved === "object") {
            settings = { ...settings, ...saved };
        }
    } catch {
        localStorage.removeItem("noteflow-settings");
    }

    applySettings();
}

function applySettings() {
    document.body.dataset.theme = settings.theme;

    $("themeSelect").value = settings.theme;
    $("sensitivitySelect").value = settings.sensitivity;
    $("stabilitySelect").value = String(settings.stability);
    $("updateSelect").value = String(settings.update);
    $("notationSelect").value = settings.notation;
    $("showFrequency").checked = settings.showFrequency;

    $("frequencyValue").parentElement.style.display =
        settings.showFrequency ? "flex" : "none";
}

function saveSettings() {
    settings.theme = $("themeSelect").value;
    settings.sensitivity = $("sensitivitySelect").value;
    settings.stability = Number($("stabilitySelect").value);
    settings.update = Number($("updateSelect").value);
    settings.notation = $("notationSelect").value;
    settings.showFrequency = $("showFrequency").checked;

    localStorage.setItem("noteflow-settings", JSON.stringify(settings));

    applySettings();
    renderAll();
    $("settingsModal").classList.add("hidden");

    showToast("Impostazioni salvate");
}

function openSettings() {
    $("settingsModal").classList.remove("hidden");
}

function closeSettings() {
    $("settingsModal").classList.add("hidden");
}

function chooseFile() {
    fileInput.click();
}

function handleFile(file) {
    if (!file) return;

    if (!file.type.startsWith("audio/") && !file.type.startsWith("video/")) {
        showToast("Seleziona un file audio o video valido");
        return;
    }

    stopAnalysis();

    if (currentObjectUrl) {
        URL.revokeObjectURL(currentObjectUrl);
    }

    currentMedia = file;
    currentObjectUrl = URL.createObjectURL(file);

    const isVideo = file.type.startsWith("video/");

    audioPlayer.pause();
    videoPlayer.pause();

    audioPlayer.classList.toggle("hidden", isVideo);
    videoPlayer.classList.toggle("hidden", !isVideo);

    if (isVideo) {
        videoPlayer.src = currentObjectUrl;
        videoPlayer.load();
    } else {
        audioPlayer.src = currentObjectUrl;
        audioPlayer.load();
    }

    $("fileName").textContent = file.name;
    $("fileSize").textContent = `${(file.size / (1024 * 1024)).toFixed(2)} MB`;

    $("selectedFile").classList.remove("hidden");
    workspace.classList.remove("hidden");

    resetAnalysis();

    $("analysisStatus").textContent = "Pronto per l'analisi";
    $("statusText").textContent = "In pausa";

    showToast("Brano caricato");
}

function getPlayer() {
    return currentMedia && currentMedia.type.startsWith("video/")
        ? videoPlayer
        : audioPlayer;
}

function removeFile() {
    stopAnalysis();

    audioPlayer.pause();
    videoPlayer.pause();

    audioPlayer.removeAttribute("src");
    videoPlayer.removeAttribute("src");

    if (currentObjectUrl) {
        URL.revokeObjectURL(currentObjectUrl);
        currentObjectUrl = null;
    }

    currentMedia = null;

    $("selectedFile").classList.add("hidden");
    workspace.classList.add("hidden");

    resetAnalysis();
}

function resetAnalysis() {
    sequenceEntries = [];
    historyEntries = [];

    lastCandidateMidi = null;
    candidateSince = 0;
    activeMidi = null;
    activeSegment = null;
    lastDetectedTime = 0;
    lastRenderTime = 0;

    $("currentNote").textContent = "--";
    $("noteDetails").textContent = "Riproduci il brano per iniziare";
    $("frequencyValue").textContent = "-- Hz";
    $("confidenceValue").textContent = "--";
    $("meterFill").style.width = "0%";
    $("liveIndicator").classList.remove("active");

    renderAll();
    highlightKeyboard(null);
}

async function initializeAudio() {
    const player = getPlayer();

    if (audioContext && sourceNode) {
        return true;
    }

    try {
        const AudioContextClass =
            window.AudioContext || window.webkitAudioContext;

        if (!AudioContextClass) {
            showToast("Il browser non supporta l'analisi audio");
            return false;
        }

        audioContext = new AudioContextClass();

        analyser = audioContext.createAnalyser();
        analyser.fftSize = 8192;
        analyser.smoothingTimeConstant = 0;

        sourceNode = audioContext.createMediaElementSource(player);
        sourceNode.connect(analyser);
        analyser.connect(audioContext.destination);

        analysisBuffer = new Float32Array(analyser.fftSize);

        return true;
    } catch (error) {
        console.error(error);
        showToast("Errore durante l'avvio dell'analisi audio");
        return false;
    }
}

async function startAnalysis() {
    if (!currentMedia) return;

    const ready = await initializeAudio();

    if (!ready) return;

    try {
        if (audioContext.state === "suspended") {
            await audioContext.resume();
        }

        stopAnalysis(false);

        const player = getPlayer();

        if (player.paused) {
            await player.play();
        }

        $("statusText").textContent = "In riproduzione";
        $("analysisStatus").textContent = "Analisi in corso";
        $("liveIndicator").classList.add("active");

        animationTimer = setInterval(
            analyseAudio,
            Math.max(35, settings.update)
        );
    } catch (error) {
        console.error(error);
        showToast("Impossibile avviare la riproduzione");
    }
}

function stopAnalysis(pausePlayer = true) {
    if (animationTimer) {
        clearInterval(animationTimer);
        animationTimer = null;
    }

    if (pausePlayer) {
        audioPlayer.pause();
        videoPlayer.pause();
    }

    $("statusText").textContent = "In pausa";
    $("analysisStatus").textContent = "Analisi in pausa";
    $("liveIndicator").classList.remove("active");
}

function getRms(buffer) {
    let sum = 0;

    for (let i = 0; i < buffer.length; i++) {
        sum += buffer[i] * buffer[i];
    }

    return Math.sqrt(sum / buffer.length);
}

function detectPitchYIN(buffer, sampleRate) {
    const size = buffer.length;
    const halfSize = Math.floor(size / 2);

    const rms = getRms(buffer);

    const minimumRms = {
        low: 0.008,
        medium: 0.005,
        high: 0.003
    }[settings.sensitivity];

    if (rms < minimumRms) {
        return null;
    }

    const difference = new Float32Array(halfSize);
    const cumulativeMean = new Float32Array(halfSize);

    const minFrequency = 55;
    const maxFrequency = 1200;

    const minPeriod = Math.floor(sampleRate / maxFrequency);
    const maxPeriod = Math.min(
        Math.floor(sampleRate / minFrequency),
        halfSize - 1
    );

    for (let tau = 1; tau <= maxPeriod; tau++) {
        let sum = 0;

        for (let i = 0; i < halfSize; i++) {
            const delta = buffer[i] - buffer[i + tau];
            sum += delta * delta;
        }

        difference[tau] = sum;
    }

    cumulativeMean[0] = 1;

    let runningSum = 0;

    for (let tau = 1; tau <= maxPeriod; tau++) {
        runningSum += difference[tau];

        cumulativeMean[tau] = runningSum === 0
            ? 1
            : difference[tau] * tau / runningSum;
    }

    const threshold = {
        low: 0.12,
        medium: 0.16,
        high: 0.21
    }[settings.sensitivity];

    let selectedPeriod = -1;

    for (let tau = minPeriod; tau <= maxPeriod; tau++) {
        if (cumulativeMean[tau] < threshold) {
            while (
                tau + 1 <= maxPeriod &&
                cumulativeMean[tau + 1] < cumulativeMean[tau]
            ) {
                tau++;
            }

            selectedPeriod = tau;
            break;
        }
    }

    if (selectedPeriod === -1) {
        let bestValue = Infinity;

        for (let tau = minPeriod; tau <= maxPeriod; tau++) {
            if (cumulativeMean[tau] < bestValue) {
                bestValue = cumulativeMean[tau];
                selectedPeriod = tau;
            }
        }

        if (bestValue > 0.30) return null;
    }

    const previous = selectedPeriod - 1;
    const next = selectedPeriod + 1;

    let refinedPeriod = selectedPeriod;

    if (previous > 0 && next <= maxPeriod) {
        const a = cumulativeMean[previous];
        const b = cumulativeMean[selectedPeriod];
        const c = cumulativeMean[next];

        const denominator = 2 * (2 * b - a - c);

        if (denominator !== 0) {
            refinedPeriod += (a - c) / denominator;
        }
    }

    const frequency = sampleRate / refinedPeriod;

    if (
        frequency < minFrequency ||
        frequency > maxFrequency ||
        !Number.isFinite(frequency)
    ) {
        return null;
    }

    const clarity = Math.max(
        0,
        Math.min(1, 1 - cumulativeMean[selectedPeriod])
    );

    if (clarity < 0.65) return null;

    const midi = Math.round(69 + 12 * Math.log2(frequency / 440));

    return {
        frequency,
        midi,
        clarity,
        rms
    };
}

function analyseAudio() {
    if (!analyser || !analysisBuffer) return;

    const player = getPlayer();

    if (player.paused || player.ended) {
        stopAnalysis(false);
        closeActiveSegment();
        return;
    }

    analyser.getFloatTimeDomainData(analysisBuffer);

    const result = detectPitchYIN(
        analysisBuffer,
        audioContext.sampleRate
    );

    const now = performance.now();

    if (!result) {
        if (now - lastDetectedTime > 170) {
            lastCandidateMidi = null;
            candidateSince = 0;

            if (activeMidi !== null) {
                closeActiveSegment();
            }

            $("currentNote").textContent = "--";
            $("noteDetails").textContent = "In ascolto...";
            $("frequencyValue").textContent = "-- Hz";
            $("confidenceValue").textContent = "--";
            $("meterFill").style.width = "0%";

            highlightKeyboard(null);
        }

        return;
    }

    lastDetectedTime = now;

    const midi = result.midi;

    $("frequencyValue").textContent =
        `${result.frequency.toFixed(1)} Hz`;

    $("confidenceValue").textContent =
        `${Math.round(result.clarity * 100)}%`;

    $("meterFill").style.width =
        `${Math.round(result.clarity * 100)}%`;

    if (lastCandidateMidi !== midi) {
        lastCandidateMidi = midi;
        candidateSince = now;
    }

    if (now - candidateSince < settings.stability) {
        return;
    }

    if (activeMidi !== midi) {
        closeActiveSegment();

        activeMidi = midi;

        activeSegment = {
            midi,
            name: getNoteName(midi),
            frequency: result.frequency,
            start: player.currentTime,
            end: player.currentTime,
            duration: 0,
            occurrences: 1
        };

        sequenceEntries.push(activeSegment);

        addHistory(activeSegment);
        renderAll();
    } else if (activeSegment) {
        activeSegment.end = player.currentTime;
        activeSegment.duration = Math.max(
            0,
            activeSegment.end - activeSegment.start
        );

        activeSegment.frequency = result.frequency;
    }

    $("currentNote").textContent = getNoteName(midi);
    $("noteDetails").textContent =
        `${result.frequency.toFixed(1)} Hz · ${Math.round(result.clarity * 100)}% di affidabilità`;

    highlightKeyboard(midi);

    if (now - lastRenderTime > 250) {
        lastRenderTime = now;
        renderKaraoke();
        renderSummary();
        renderHistory();
    }
}

function closeActiveSegment() {
    if (activeSegment) {
        const player = currentMedia ? getPlayer() : null;

        if (player) {
            activeSegment.end = Math.max(
                activeSegment.start,
                player.currentTime
            );
        }

        activeSegment.duration = Math.max(
            0,
            activeSegment.end - activeSegment.start
        );

        activeSegment = null;
    }

    activeMidi = null;
}

function addHistory(segment) {
    historyEntries.unshift({
        name: segment.name,
        time: segment.start
    });

    if (historyEntries.length > 30) {
        historyEntries.length = 30;
    }

    renderHistory();
}

function renderKaraoke() {
    const container = $("karaokeDisplay");

    if (sequenceEntries.length === 0) {
        container.innerHTML =
            '<span class="empty-message">Le note riconosciute appariranno qui.</span>';
        $("sequenceCount").textContent = "0 note";
        return;
    }

    const player = currentMedia ? getPlayer() : null;
    const currentTime = player ? player.currentTime : 0;

    container.innerHTML = "";

    sequenceEntries.forEach((entry, index) => {
        const element = document.createElement("div");
        element.className = "karaoke-note";

        const isActive =
            currentTime >= entry.start &&
            (
                currentTime <= entry.end ||
                index === sequenceEntries.length - 1 &&
                activeSegment === entry
            );

        if (isActive) {
            element.classList.add("active");
        }

        const name = document.createElement("strong");
        name.textContent = entry.name;

        const time = document.createElement("span");
        time.textContent = `${formatTime(entry.start)} · ${entry.duration.toFixed(1)}s`;

        element.append(name, time);
        container.appendChild(element);
    });

    $("sequenceCount").textContent =
        `${sequenceEntries.length} segmenti`;
}

function renderSummary() {
    const container = $("summaryList");

    const uniqueNotes = new Map();

    sequenceEntries.forEach(entry => {
        if (!uniqueNotes.has(entry.midi)) {
            uniqueNotes.set(entry.midi, {
                midi: entry.midi,
                name: getNoteName(entry.midi),
                count: 0,
                duration: 0
            });
        }

        const note = uniqueNotes.get(entry.midi);

        note.count++;
        note.duration += entry.duration;
    });

    const sorted = [...uniqueNotes.values()]
        .sort((a, b) => a.midi - b.midi);

    $("uniqueCount").textContent =
        `${sorted.length} note diverse`;

    if (sorted.length === 0) {
        container.innerHTML =
            '<span class="empty-message">Il riepilogo apparirà durante l\'analisi.</span>';
        return;
    }

    container.innerHTML = "";

    sorted.forEach(note => {
        const element = document.createElement("div");
        element.className = "summary-note";

        const name = document.createElement("strong");
        name.textContent = note.name;

        const count = document.createElement("span");
        count.textContent = `${note.count} occorrenze`;

        const duration = document.createElement("span");
        duration.textContent = `${note.duration.toFixed(1)} secondi`;

        element.append(name, count, duration);
        container.appendChild(element);
    });
}

function renderHistory() {
    const container = $("noteHistory");

    if (historyEntries.length === 0) {
        container.innerHTML =
            '<span class="empty-message">Nessuna nota rilevata.</span>';
        return;
    }

    container.innerHTML = "";

    historyEntries.forEach(entry => {
        const element = document.createElement("span");
        element.className = "history-item";
        element.textContent =
            `${entry.name} · ${formatTime(entry.time)}`;

        container.appendChild(element);
    });
}

function renderAll() {
    renderKaraoke();
    renderSummary();
    renderHistory();
    renderKeyboard();
}

function renderKeyboard() {
    const keyboard = $("pianoKeyboard");

    keyboard.innerHTML = "";

    const startMidi = 48;
    const endMidi = 83;

    const blackNotes = [1, 3, 6, 8, 10];
    const whiteWidth = 34;

    let whiteIndex = 0;
    const blackKeys = [];

    for (let midi = startMidi; midi <= endMidi; midi++) {
        const noteIndex = midi % 12;
        const isBlack = blackNotes.includes(noteIndex);

        if (!isBlack) {
            const key = document.createElement("div");
            key.className = "piano-key";
            key.dataset.midi = midi;

            const label = document.createElement("span");
            label.textContent = noteIndex === 0
                ? `DO${Math.floor(midi / 12) - 1}`
                : "";

            key.appendChild(label);
            keyboard.appendChild(key);

            whiteIndex++;
        } else {
            const key = document.createElement("div");
            key.className = "piano-key black";
            key.dataset.midi = midi;

            const previousWhiteIndex = whiteIndex - 1;

            key.style.left =
                `${previousWhiteIndex * whiteWidth + whiteWidth - 11}px`;

            blackKeys.push(key);
        }
    }

    blackKeys.forEach(key => keyboard.appendChild(key));
}

function highlightKeyboard(midi) {
    document.querySelectorAll(".piano-key").forEach(key => {
        key.classList.toggle(
            "active",
            midi !== null && Number(key.dataset.midi) === midi
        );
    });
}

function syncPlayerStatus() {
    const player = getPlayer();

    if (!currentMedia) return;

    if (player.paused || player.ended) {
        stopAnalysis(false);
        closeActiveSegment();
    } else if (!animationTimer) {
        startAnalysis();
    }

    $("statusText").textContent =
        player.paused ? "In pausa" : "In riproduzione";
}

function clearHistory() {
    historyEntries = [];
    renderHistory();
}

function onTimeUpdate() {
    if (!currentMedia) return;

    renderKaraoke();
}

function setupPlayerEvents(player) {
    player.addEventListener("play", () => {
        if (!animationTimer) {
            startAnalysis();
        }
    });

    player.addEventListener("pause", () => {
        stopAnalysis(false);
        closeActiveSegment();
        renderAll();
    });

    player.addEventListener("ended", () => {
        stopAnalysis(false);
        closeActiveSegment();
        renderAll();
        $("analysisStatus").textContent = "Analisi completata";
    });

    player.addEventListener("timeupdate", onTimeUpdate);
}

function initializeEvents() {
    $("chooseFileButton").addEventListener("click", chooseFile);

    fileInput.addEventListener("change", event => {
        handleFile(event.target.files[0]);
        fileInput.value = "";
    });

    $("removeFileButton").addEventListener("click", removeFile);

    $("settingsButton").addEventListener("click", openSettings);
    $("closeSettings").addEventListener("click", closeSettings);
    $("saveSettings").addEventListener("click", saveSettings);

    $("clearHistory").addEventListener("click", clearHistory);

    $("playbackSpeed").addEventListener("change", event => {
        const speed = Number(event.target.value);

        audioPlayer.playbackRate = speed;
        videoPlayer.playbackRate = speed;
    });

    dropZone.addEventListener("dragover", event => {
        event.preventDefault();
        dropZone.classList.add("drag-over");
    });

    dropZone.addEventListener("dragleave", () => {
        dropZone.classList.remove("drag-over");
    });

    dropZone.addEventListener("drop", event => {
        event.preventDefault();
        dropZone.classList.remove("drag-over");

        const file = event.dataTransfer.files[0];

        if (file) {
            handleFile(file);
        }
    });

    $("settingsModal").addEventListener("click", event => {
        if (event.target === $("settingsModal")) {
            closeSettings();
        }
    });

    setupPlayerEvents(audioPlayer);
    setupPlayerEvents(videoPlayer);
}

loadSettings();
initializeEvents();
renderKeyboard();
renderAll();
