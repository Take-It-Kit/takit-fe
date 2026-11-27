/** @type {import('tailwindcss').Config} */
module.exports = {
  // 프로젝트 내 컴포넌트 파일 경로를 모두 포함시킵니다.
  content: ["./src/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {},
  },
  plugins: [],
};
