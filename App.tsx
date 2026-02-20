import React, { useState, useRef, useCallback, useEffect } from "react";
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  SafeAreaView,
  Platform,
  ActivityIndicator,
  Animated,
  TextInput,
  KeyboardAvoidingView,
  Alert,
  Modal,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Speech from "expo-speech";
import { Ionicons } from "@expo/vector-icons";

// ── expo-speech-recognition: Expo Go에서는 없을 수 있음 ──
let ExpoSpeechRecognitionModule: any = null;
let useSpeechRecognitionEvent: any = () => {};
let hasSpeechRecognition = false;

try {
  const mod = require("expo-speech-recognition");
  ExpoSpeechRecognitionModule = mod.ExpoSpeechRecognitionModule;
  useSpeechRecognitionEvent = mod.useSpeechRecognitionEvent;
  hasSpeechRecognition = !!ExpoSpeechRecognitionModule;
} catch (e) {
  // Expo Go - 네이티브 모듈 없음
  hasSpeechRecognition = false;
}

// ── Gemini API ──
const GEMINI_API_KEY = process.env.EXPO_PUBLIC_GEMINI_API_KEY || "";
const GEMINI_MODEL = "gemini-2.0-flash";

async function callGemini(prompt: string, apiKey: string = ""): Promise<string> {
  const finalKey = apiKey || GEMINI_API_KEY;
  if (!finalKey) {
    return "API 키가 설정되지 않았습니다. 우측 상단의 톱니바퀴 아이콘(설정)을 눌러 Gemini API 키를 입력해주세요.";
  }
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${finalKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 1024 },
        }),
      }
    );
    const data = await res.json();
    return (
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "죄송합니다. 응답을 받지 못했습니다."
    );
  } catch (e: any) {
    return `오류가 발생했습니다: ${e.message}`;
  }
}

// ── 날씨 API (wttr.in - 무료, API키 불필요) ──
async function fetchWeather(city: string = "Seoul"): Promise<string> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(
      `https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=ko`,
      {
        signal: controller.signal,
        headers: { "User-Agent": "sonol-voice/1.0" },
      }
    );
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const current = data.current_condition?.[0];
    if (!current) throw new Error("날씨 데이터 없음");
    const temp = current.temp_C;
    const feelsLike = current.FeelsLikeC;
    const humidity = current.humidity;
    const desc =
      current.lang_ko?.[0]?.value || current.weatherDesc?.[0]?.value || "";
    const wind = current.windspeedKmph;
    const area = data.nearest_area?.[0];
    const location = area?.areaName?.[0]?.value || city;
    return `현재 ${location} 날씨: ${desc}, 기온 ${temp}°C (체감 ${feelsLike}°C), 습도 ${humidity}%, 바람 ${wind}km/h`;
  } catch (e: any) {
    console.warn("날씨 API 오류:", e.message);
    // Fallback: Gemini에게 날씨를 직접 물어보도록 안내
    return "[날씨 데이터를 가져오지 못했습니다. 일반적인 날씨 안내를 해주세요.]";
  }
}

// ── 날씨 요청 감지 ──
function isWeatherQuery(text: string): boolean {
  const keywords = [
    "날씨", "기온", "온도", "비 오", "눈 오", "추워", "더워",
    "weather", "비와", "비가", "눈이", "바람",
  ];
  return keywords.some((k) => text.includes(k));
}

// ── 시스템 프롬프트 ──
const SYSTEM_PROMPT = `당신은 '소놀비서'입니다. 시니어(노인)를 위한 친절한 음성 비서입니다.
규칙:
- 항상 존댓말을 사용하세요
- 짧고 명확하게 답변하세요 (3문장 이내)
- 어려운 기술 용어는 쉬운 말로 바꾸세요
- 따뜻하고 친절한 어조를 유지하세요
- 이메일, 문자, 일정 등 요청하면 도와주세요
- 날씨 정보가 제공되면 그 데이터를 활용하여 자연스럽게 답변하세요`;

// ── 대화 타입 ──
type Message = {
  role: "user" | "assistant";
  text: string;
  timestamp: Date;
};

export default function App() {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      text: '안녕하세요! 소놀비서입니다. 🎤\n\n아래 버튼을 눌러 말씀해주시거나\n글로 입력해주세요.\n\n"날씨 알려줘", "이메일 읽어줘" 등\n무엇이든 도와드릴게요!',
      timestamp: new Date(),
    },
  ]);
  const [isListening, setIsListening] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [inputText, setInputText] = useState("");
  const [showInput, setShowInput] = useState(false);
  const [customApiKey, setCustomApiKey] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [tempApiKey, setTempApiKey] = useState("");
  const scrollRef = useRef<ScrollView>(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;

  // ── 저장된 API 키 불러오기 ──
  useEffect(() => {
    AsyncStorage.getItem("custom_gemini_api_key").then((val) => {
      if (val) setCustomApiKey(val);
    });
  }, []);

  // ── 네이티브 음성 인식 이벤트 (expo-speech-recognition) ──
  // 참고: hasSpeechRecognition이 false면 useSpeechRecognitionEvent는 빈 함수
  useSpeechRecognitionEvent("start", () => {
    setIsListening(true);
    startPulse();
  });

  useSpeechRecognitionEvent("end", () => {
    setIsListening(false);
    stopPulse();
  });

  useSpeechRecognitionEvent("result", (event: any) => {
    const transcript = event.results[0]?.transcript;
    if (transcript) {
      setIsListening(false);
      stopPulse();
      processUserInput(transcript);
    }
  });

  useSpeechRecognitionEvent("error", (event: any) => {
    console.warn("STT error:", event.error, event.message);
    setIsListening(false);
    stopPulse();
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      Alert.alert(
        "마이크 권한 필요",
        "마이크 사용 권한을 허용해주세요.\n설정에서 마이크 권한을 확인해주세요."
      );
    } else if (event.error === "no-speech") {
      // 조용히 무시 - 말을 안 한 경우
    } else {
      Alert.alert("음성 인식 오류", `다시 시도해주세요.\n(${event.error})`);
    }
  });

  // ── 음성 출력 (TTS) ──
  const speak = useCallback((text: string) => {
    setIsSpeaking(true);
    Speech.speak(text, {
      language: "ko-KR",
      rate: 0.85,
      onDone: () => setIsSpeaking(false),
      onError: () => setIsSpeaking(false),
    });
  }, []);

  const stopSpeaking = useCallback(() => {
    Speech.stop();
    setIsSpeaking(false);
  }, []);

  // ── 펄스 애니메이션 (듣는 중) ──
  const startPulse = useCallback(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.2,
          duration: 600,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 600,
          useNativeDriver: true,
        }),
      ])
    ).start();
  }, [pulseAnim]);

  const stopPulse = useCallback(() => {
    pulseAnim.stopAnimation();
    pulseAnim.setValue(1);
  }, [pulseAnim]);

  // ── AI 처리 ──
  const processUserInput = useCallback(
    async (userText: string) => {
      const userMsg: Message = {
        role: "user",
        text: userText,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, userMsg]);
      setIsProcessing(true);

      // 날씨 요청이면 실시간 데이터 가져오기
      let weatherInfo = "";
      if (isWeatherQuery(userText)) {
        weatherInfo = await fetchWeather("Seoul");
      }

      // 대화 히스토리 구성
      const historyText = messages
        .slice(-6)
        .map((m) => `${m.role === "user" ? "사용자" : "비서"}: ${m.text}`)
        .join("\n");

      const weatherContext = weatherInfo
        ? `\n\n[실시간 날씨 데이터] ${weatherInfo}`
        : "";

      const prompt = `${SYSTEM_PROMPT}${weatherContext}\n\n이전 대화:\n${historyText}\n\n사용자: ${userText}\n\n비서:`;

      const reply = await callGemini(prompt, customApiKey);

      const assistantMsg: Message = {
        role: "assistant",
        text: reply,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, assistantMsg]);
      setIsProcessing(false);

      // 자동 음성 출력
      speak(reply);

      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
    },
    [messages, speak]
  );

  // ── 음성 인식 시작 ──
  const startListening = useCallback(async () => {
    if (!hasSpeechRecognition) {
      Alert.alert(
        "음성 인식 불가",
        "Expo Go에서는 음성 인식이 지원되지 않습니다.\n\n텍스트로 입력하시거나, 빌드된 앱(APK/AAB)에서 음성 인식을 사용해주세요.",
        [
          { text: "글로 입력", onPress: () => setShowInput(true) },
          { text: "확인" },
        ]
      );
      return;
    }

    if (isSpeaking) stopSpeaking();

    // 권한 요청
    const result = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!result.granted) {
      Alert.alert(
        "권한 필요",
        "음성 인식을 사용하려면 마이크 권한을 허용해주세요."
      );
      return;
    }

    // 음성 인식 시작
    ExpoSpeechRecognitionModule.start({
      lang: "ko-KR",
      interimResults: false,
      continuous: false,
      addsPunctuation: true,
    });
  }, [isSpeaking, stopSpeaking]);

  // ── 음성 인식 중단 ──
  const stopListening = useCallback(() => {
    if (hasSpeechRecognition) {
      ExpoSpeechRecognitionModule.stop();
    }
    setIsListening(false);
    stopPulse();
  }, [stopPulse]);

  // ── 텍스트 전송 ──
  const sendText = useCallback(() => {
    const text = inputText.trim();
    if (!text || isProcessing) return;
    setInputText("");
    processUserInput(text);
  }, [inputText, isProcessing, processUserInput]);

  // ── 빠른 명령 버튼 ──
  const quickCommands = [
    { icon: "mail-outline", label: "이메일", cmd: "이메일 확인해줘" },
    { icon: "sunny-outline", label: "날씨", cmd: "오늘 날씨 알려줘" },
    { icon: "calendar-outline", label: "일정", cmd: "오늘 일정 뭐야?" },
    { icon: "call-outline", label: "전화", cmd: "딸에게 전화 연결해줘" },
  ];

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {/* 헤더 */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>🎤 소놀비서</Text>
          <Text style={styles.headerSub}>음성으로 무엇이든 도와드려요</Text>
          <TouchableOpacity 
            style={styles.settingsBtn} 
            onPress={() => {
              setTempApiKey(customApiKey);
              setShowSettings(true);
            }}
          >
            <Ionicons name="settings-outline" size={26} color="#4a90d9" />
          </TouchableOpacity>
        </View>

        {/* 대화 영역 */}
        <ScrollView
          ref={scrollRef}
          style={styles.chatArea}
          contentContainerStyle={styles.chatContent}
          onContentSizeChange={() =>
            scrollRef.current?.scrollToEnd({ animated: true })
          }
        >
          {messages.map((msg, i) => (
            <View
              key={i}
              style={[
                styles.msgBubble,
                msg.role === "user" ? styles.userBubble : styles.assistantBubble,
              ]}
            >
              <Text
                style={[
                  styles.msgText,
                  msg.role === "user" ? styles.userText : styles.assistantText,
                ]}
              >
                {msg.text}
              </Text>
            </View>
          ))}
          {isProcessing && (
            <View style={[styles.msgBubble, styles.assistantBubble]}>
              <ActivityIndicator color="#4a90d9" size="small" />
              <Text style={styles.processingText}>생각하는 중...</Text>
            </View>
          )}
        </ScrollView>

        {/* 빠른 명령 */}
        <View style={styles.quickRow}>
          {quickCommands.map((qc, i) => (
            <TouchableOpacity
              key={i}
              style={styles.quickBtn}
              onPress={() => processUserInput(qc.cmd)}
              disabled={isProcessing}
            >
              <Ionicons name={qc.icon as any} size={28} color="#fff" />
              <Text style={styles.quickLabel}>{qc.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* 하단 영역 */}
        <View style={styles.bottomArea}>
          {isSpeaking && (
            <TouchableOpacity style={styles.stopBtn} onPress={stopSpeaking}>
              <Ionicons name="stop-circle" size={24} color="#ff6b6b" />
              <Text style={styles.stopText}>읽기 중단</Text>
            </TouchableOpacity>
          )}

          {showInput ? (
            /* 텍스트 입력 모드 */
            <View style={styles.inputRow}>
              <TouchableOpacity
                style={styles.inputToggle}
                onPress={() => setShowInput(false)}
              >
                <Ionicons name="mic-outline" size={28} color="#4a90d9" />
              </TouchableOpacity>
              <TextInput
                style={styles.textInput}
                value={inputText}
                onChangeText={setInputText}
                placeholder="여기에 입력하세요..."
                placeholderTextColor="#666"
                returnKeyType="send"
                onSubmitEditing={sendText}
                editable={!isProcessing}
              />
              <TouchableOpacity
                style={[styles.sendBtn, !inputText.trim() && { opacity: 0.4 }]}
                onPress={sendText}
                disabled={isProcessing || !inputText.trim()}
              >
                <Ionicons name="send" size={24} color="#fff" />
              </TouchableOpacity>
            </View>
          ) : (
            /* 음성 입력 모드 */
            <View style={styles.micArea}>
              <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
                <TouchableOpacity
                  style={[
                    styles.micBtn,
                    isListening && styles.micBtnActive,
                    isProcessing && styles.micBtnDisabled,
                  ]}
                  onPress={isListening ? stopListening : startListening}
                  disabled={isProcessing}
                  activeOpacity={0.7}
                >
                  <Ionicons
                    name={isListening ? "mic" : "mic-outline"}
                    size={60}
                    color="#fff"
                  />
                  <Text style={styles.micLabel}>
                    {isListening
                      ? "듣고 있어요..."
                      : isProcessing
                      ? "처리 중..."
                      : "눌러서 말하기"}
                  </Text>
                </TouchableOpacity>
              </Animated.View>
              <TouchableOpacity
                style={styles.keyboardToggle}
                onPress={() => setShowInput(true)}
              >
                <Ionicons
                  name="chatbubble-ellipses-outline"
                  size={22}
                  color="#8899aa"
                />
                <Text style={styles.keyboardLabel}>글로 입력</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </KeyboardAvoidingView>

      {/* 설정 모달 */}
      <Modal visible={showSettings} animationType="fade" transparent={true}>
        <KeyboardAvoidingView 
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={styles.modalContainer}
        >
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>설정</Text>
            
            <Text style={styles.modalLabel}>Gemini API 키</Text>
            <TextInput
              style={styles.modalInput}
              value={tempApiKey}
              onChangeText={setTempApiKey}
              placeholder="API 키를 입력하세요"
              placeholderTextColor="#556677"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={styles.modalHelper}>
              * API 키는 기기에만 안전하게 저장됩니다.
            </Text>

            <View style={styles.modalBtnRow}>
              <TouchableOpacity 
                style={[styles.modalBtn, { backgroundColor: "#2a2a4a" }]}
                onPress={() => setShowSettings(false)}
              >
                <Text style={styles.modalBtnText}>취소</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={[styles.modalBtn, { backgroundColor: "#4a90d9" }]}
                onPress={async () => {
                  const key = tempApiKey.trim();
                  if (key) {
                    await AsyncStorage.setItem("custom_gemini_api_key", key);
                  } else {
                    await AsyncStorage.removeItem("custom_gemini_api_key");
                  }
                  setCustomApiKey(key);
                  setShowSettings(false);
                }}
              >
                <Text style={styles.modalBtnText}>저장</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#1a1a2e",
  },
  header: {
    paddingTop: Platform.OS === "android" ? 40 : 10,
    paddingBottom: 12,
    paddingHorizontal: 20,
    backgroundColor: "#16213e",
    borderBottomWidth: 1,
    borderBottomColor: "#2a2a4a",
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: "bold",
    color: "#fff",
    textAlign: "center",
  },
  headerSub: {
    fontSize: 16,
    color: "#8899aa",
    textAlign: "center",
    marginTop: 4,
  },
  settingsBtn: {
    position: "absolute",
    right: 20,
    top: Platform.OS === "android" ? 45 : 15,
    padding: 5,
    backgroundColor: "#2a2a4a",
    borderRadius: 20,
  },
  chatArea: {
    flex: 1,
    paddingHorizontal: 16,
  },
  chatContent: {
    paddingVertical: 16,
  },
  msgBubble: {
    maxWidth: "85%",
    padding: 16,
    borderRadius: 20,
    marginBottom: 12,
  },
  userBubble: {
    backgroundColor: "#4a90d9",
    alignSelf: "flex-end",
    borderBottomRightRadius: 6,
  },
  assistantBubble: {
    backgroundColor: "#2a2a4a",
    alignSelf: "flex-start",
    borderBottomLeftRadius: 6,
  },
  msgText: {
    fontSize: 20,
    lineHeight: 30,
  },
  userText: {
    color: "#fff",
  },
  assistantText: {
    color: "#e0e0e0",
  },
  processingText: {
    color: "#8899aa",
    fontSize: 18,
    marginLeft: 8,
  },
  quickRow: {
    flexDirection: "row",
    justifyContent: "space-around",
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: "#16213e",
  },
  quickBtn: {
    alignItems: "center",
    padding: 10,
    borderRadius: 12,
    backgroundColor: "#2a3a5e",
    width: 75,
  },
  quickLabel: {
    color: "#ccc",
    fontSize: 14,
    marginTop: 4,
  },
  bottomArea: {
    alignItems: "center",
    paddingBottom: Platform.OS === "android" ? 20 : 10,
    paddingTop: 8,
    backgroundColor: "#16213e",
  },
  stopBtn: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 8,
    padding: 8,
    borderRadius: 20,
    backgroundColor: "rgba(255,107,107,0.15)",
  },
  stopText: {
    color: "#ff6b6b",
    fontSize: 16,
    marginLeft: 6,
  },
  micBtn: {
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: "#4a90d9",
    justifyContent: "center",
    alignItems: "center",
    elevation: 8,
    shadowColor: "#4a90d9",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
  },
  micBtnActive: {
    backgroundColor: "#e74c3c",
  },
  micBtnDisabled: {
    backgroundColor: "#555",
    opacity: 0.6,
  },
  micLabel: {
    color: "#fff",
    fontSize: 16,
    marginTop: 4,
    fontWeight: "600",
  },
  micArea: {
    alignItems: "center",
  },
  keyboardToggle: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 12,
    padding: 8,
  },
  keyboardLabel: {
    color: "#8899aa",
    fontSize: 14,
    marginLeft: 6,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    width: "100%",
  },
  inputToggle: {
    padding: 8,
    marginRight: 8,
  },
  textInput: {
    flex: 1,
    backgroundColor: "#2a2a4a",
    color: "#fff",
    fontSize: 18,
    borderRadius: 24,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  sendBtn: {
    backgroundColor: "#4a90d9",
    borderRadius: 24,
    padding: 10,
    marginLeft: 8,
  },
  modalContainer: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    alignItems: "center",
  },
  modalContent: {
    width: "85%",
    backgroundColor: "#16213e",
    borderRadius: 16,
    padding: 24,
    elevation: 5,
    borderWidth: 1,
    borderColor: "#2a2a4a",
  },
  modalTitle: {
    fontSize: 22,
    fontWeight: "bold",
    color: "#fff",
    marginBottom: 20,
    textAlign: "center",
  },
  modalLabel: {
    fontSize: 14,
    color: "#8899aa",
    marginBottom: 8,
    fontWeight: "600",
  },
  modalInput: {
    backgroundColor: "#0d1428",
    color: "#fff",
    borderWidth: 1,
    borderColor: "#2a2a4a",
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    marginBottom: 8,
  },
  modalHelper: {
    fontSize: 12,
    color: "#ff6b6b",
    marginBottom: 24,
  },
  modalBtnRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  modalBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: "center",
    marginHorizontal: 4,
  },
  modalBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "bold",
  },
});
