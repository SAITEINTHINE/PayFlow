// static/app.js

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => {
      console.warn('[SW] Registration failed', err);
    });
  });
}

// ==============================
// Global/state (kept from your code; extended)
// ==============================
let userProfile = {
  username: localStorage.getItem('username') || 'Guest',
  email: localStorage.getItem('email') || '-',
  pic: localStorage.getItem('profilePic') || `https://ui-avatars.com/api/?name=${encodeURIComponent(localStorage.getItem('username') || 'Guest')}`
};

let shiftHistory = []; // now loaded from server
let jobs = [];         // server-based jobs
let expenses = [];     // server-based expenses
let budgets = [];      // monthly budgets
let receipts = [];     // stored receipts
let receiptDraftItems = []; // builder line items
let currentBudgetMonth = null;
let calendarState = {
  current: new Date()
};
let lastReportPeriods = null;
let lastReportCurrency = null;
let receiptPdfFontLoaded = false;
let receiptPdfFontLoading = null;
let receiptPdfFontRegistered = false;
let receiptPdfFontBase64 = null;
let receiptPdfFontFileName = null;
const receiptPdfFontId = 'NotoSansJP';

const expenseCategoryIcons = {
  food: '🍔',
  transportation: '🚌',
  shopping: '🛍️',
  bills: '💡',
  other: '🧾'
};

const monthNames = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

const categoryTranslationKeys = {
  food: 'category_food',
  transportation: 'category_transportation',
  shopping: 'category_shopping',
  bills: 'category_bills',
  other: 'category_other'
};

const toISODate = (date) => date.toISOString().split('T')[0];

const getMonthKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

const formatMonthLabel = (date) => {
  try {
    return date.toLocaleDateString(settings.language || 'en', { month: 'long', year: 'numeric' });
  } catch (err) {
    return `${monthNames[date.getMonth()]} ${date.getFullYear()}`;
  }
};

const parseMonthInput = (value) => {
  if (!value || !/^\d{4}-\d{2}$/.test(value)) return null;
  const [year, month] = value.split('-').map(Number);
  return new Date(year, month - 1, 1);
};

const getCategoryLabel = (category) => {
  const key = categoryTranslationKeys[category] || 'category_other';
  return getTranslation(key) || category;
};

const formatTemplate = (template, variables) => template.replace(/\{(\w+)\}/g, (_, key) => {
  const value = variables[key];
  return value !== undefined && value !== null ? value : '';
});

const arrayBufferToBase64 = (buffer) => {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
};

const showInlineMessage = (el, message, isError = true) => {
  if (!el) return;
  el.textContent = message;
  el.classList.remove('hidden');
  el.classList.toggle('text-red-600', isError);
  el.classList.toggle('text-green-600', !isError);
};

const clearInlineMessage = (el) => {
  if (!el) return;
  el.textContent = '';
  el.classList.add('hidden');
  el.classList.remove('text-red-600', 'text-green-600');
};

const isValidEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((value || '').trim());

async function ensureReceiptPdfFont() {
  if (receiptPdfFontLoaded) return true;
  if (receiptPdfFontLoading) return receiptPdfFontLoading;
  const fontCandidates = [
    // Prefer the bundled TrueType font – jsPDF needs TTF to render Japanese glyphs.
    '/static/fonts/NotoSansJP-Regular.ttf',
    '/static/fonts/NotoSansCJKjp-Regular.otf',
    'https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@main/Sans/TTF/Japanese/NotoSansJP-Regular.ttf',
    'https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@main/Sans/OTF/Japanese/NotoSansCJKjp-Regular.otf'
  ];
  receiptPdfFontLoading = (async () => {
    for (const url of fontCandidates) {
      try {
        const resp = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
        if (!resp.ok) continue;
        const buffer = await resp.arrayBuffer();
        const base64 = arrayBufferToBase64(buffer);
        if (!window.jspdf || !window.jspdf.jsPDF) {
          console.warn('[PDF] jsPDF not available when registering fonts.');
          continue;
        }
        const { jsPDF } = window.jspdf;
        const fontName = url.split('/').pop() || 'NotoSansJP-Regular.ttf';
        try {
          jsPDF.API.addFileToVFS(fontName, base64);
          jsPDF.API.addFont(fontName, receiptPdfFontId, 'normal');
          receiptPdfFontRegistered = true;
          receiptPdfFontLoaded = true;
          receiptPdfFontBase64 = base64;
          receiptPdfFontFileName = fontName;
          return true;
        } catch (fontErr) {
          console.warn('[PDF] Failed to register font', fontName, fontErr);
          receiptPdfFontRegistered = false;
          receiptPdfFontBase64 = null;
          receiptPdfFontFileName = null;
        }
      } catch (err) {
        console.warn('[PDF] Failed to load font from', url, err);
      }
    }
    console.warn('[PDF] Could not load Japanese font. PDF export may show garbled characters.');
    return false;
  })();
  const success = await receiptPdfFontLoading;
  receiptPdfFontLoading = null;
  return success;
}

let settings = JSON.parse(localStorage.getItem('wageSettings')) || {
  defaultWage: 1200,
  defaultCurrency: '¥',
  defaultShiftType: 'part-time',
  autoSave: true,
  theme: 'light',
  language: 'en'
};

let advancedSettings = JSON.parse(localStorage.getItem('advancedSettings')) || {
  enableNightShift: false,
  nightStart: '22:00',
  nightEnd: '05:00',
  enableOvertime: false,
  overtimeThreshold: 8,
  overtimeRate: 150,
  mealAllowance: 0,
  transportAllowance: 0,
  weekendBonus: 0,
  enableNotifications: false,
  shiftReminders: false,
  paydayAlerts: false
};

const translations = {
  en: {
    header_title: '💰 PayFlow — Wage & Expense Manager',
    language_label: '🌐 Language',
    lang_en: 'English',
    lang_ja: 'Japanese',
    lang_my: 'Myanmar',
    lang_zh: 'Chinese',
    nav_menu_label: '📂 Menu',
    nav_calculator: '📊 Calculator',
    nav_calendar: '🗓️ Calendar',
    nav_history: '📋 History',
    nav_jobs: '🏢 Jobs',
    nav_expenses: '🧾 Expenses',
    nav_budget: '🎯 Budgets',
    nav_reports: '📈 Reports',
    nav_receipts: '🧾 Receipts',
    nav_settings: '⚙️ Settings',
    nav_advanced: '🔧 Advanced',
    nav_profile: '👤 Profile',
    calendar_heading: '🗓️ Calendar Overview',
    calendar_day_sun: 'Sun',
    calendar_day_mon: 'Mon',
    calendar_day_tue: 'Tue',
    calendar_day_wed: 'Wed',
    calendar_day_thu: 'Thu',
    calendar_day_fri: 'Fri',
    calendar_day_sat: 'Sat',
    calendar_legend_heading: 'Legend',
    calendar_shifts_heading: 'Shifts',
    calendar_expenses_heading: 'Expenses',
    history_heading: '📋 Shift History',
    history_export_pdf: '📄 PDF',
    history_export_csv: '📊 CSV',
    history_export_csv_server: '📊 CSV (Server)',
    history_col_date: 'Date',
    history_col_job: 'Job',
    history_col_type: 'Type',
    history_col_start: 'Start',
    history_col_end: 'End',
    history_col_break: 'Break',
    history_col_total_time: 'Total Time',
    history_col_hourly: 'Hourly Wage',
    history_col_total: 'Total Wage',
    history_col_actions: 'Actions',
    history_empty: 'No shift records yet. Calculate your first shift!',
    summary_total_records: 'Total Records',
    jobs_heading: '🏢 Jobs',
    jobs_label_name: 'Job Name',
    jobs_label_wage: 'Default Hourly Wage',
    jobs_label_currency: 'Currency',
    jobs_label_color: 'Color',
    jobs_add_button: '➕ Add Job',
    jobs_col_id: 'ID',
    jobs_col_name: 'Name',
    jobs_col_wage: 'Wage',
    jobs_col_currency: 'Currency',
    jobs_col_color: 'Color',
    jobs_col_actions: 'Actions',
    jobs_empty: 'No jobs yet.',
    expenses_heading: '🧾 Expenses',
    expenses_label_category: 'Category',
    expenses_label_amount: 'Amount',
    expenses_label_note: 'Note',
    expenses_add_button: '➕ Add',
    period_today: 'Today',
    category_food: 'Food',
    category_transportation: 'Transportation',
    category_shopping: 'Shopping',
    category_bills: 'Bills',
    category_other: 'Other',
    expenses_col_date: 'Date',
    expenses_col_category: 'Category',
    expenses_col_description: 'Description',
    expenses_col_amount: 'Amount',
    expenses_col_actions: 'Actions',
    expenses_empty: 'No expenses yet.',
    action_delete: 'Delete',
    action_open: 'Open',
    action_refresh: 'Refresh',
    action_remove: 'Remove',
    main_shift_details: '📝 Shift Details',
    label_job: 'Job',
    hint_job_select: 'Select a job to auto-fill the default wage & currency.',
    label_date: 'Date',
    label_start_time: 'Start Time',
    label_end_time: 'End Time',
    label_break_start: 'Break Start',
    label_break_end: 'Break End',
    label_shift_type: 'Shift Type',
    label_hourly_wage: 'Hourly Wage',
    shift_part_time: 'Part-time',
    shift_full_time: 'Full-time',
    shift_day: 'Day Shift',
    shift_night: 'Night Shift',
    btn_calculate: '🧮 Calculate Wage',
    results_heading: '💵 Results',
    calendar_details_none: 'Nothing scheduled for this day yet.',
    budget_heading: '🎯 Budgeting & Goals',
    budget_month_label: 'Month',
    budget_refresh: '🔄',
    budget_category_label: 'Category',
    budget_amount_label: 'Monthly Budget',
    budget_save_button: '💾 Save Budget',
    budget_empty: 'No budget goals yet.',
    budget_alert_near: 'Heads up! {category} spending is at {percent}% of your {amount} budget.',
    budget_alert_over: 'Alert! {category} spending exceeded the {amount} budget.',
    receipts_builder_heading: '📑 Receipt Builder',
    receipts_builder_subtitle: 'Create a 領収書 by adding line items and saving them.',
    receipts_title_label: 'Receipt Title',
    receipts_date_label: 'Receipt Date',
    receipts_note_label: 'Note',
    receipts_add_line_button: '➕ Add Line',
    receipts_line_date: 'Date',
    receipts_line_category: 'Category',
    receipts_line_description: 'Description',
    receipts_line_quantity: 'Qty',
    receipts_line_unit_price: 'Unit Price',
    receipts_line_tax: 'Tax %',
    receipts_line_total: 'Line Total',
    receipts_line_validation: 'Quantity, price, and tax must be positive values.',
    receipts_no_items: 'No line items yet. Add your first item above.',
    receipts_subtotal_label: 'Subtotal',
    receipts_tax_label: 'Tax',
    receipts_grand_label: 'Grand Total',
    receipts_clear_button: '♻️ Clear',
    receipts_save_button: '💾 Save Receipt',
    receipts_download_button: '📄 Download PDF',
    receipts_pdf_font_warning: 'Japanese font could not be loaded. PDF text may appear garbled.',
    receipts_empty: 'No receipts saved yet.',
    receipts_saved_heading: 'Saved Receipts',
    receipts_saved_amount: 'Amount',
    receipts_saved_created: 'Saved',
    receipts_items_label: 'items',
    receipts_save_success: 'Receipt saved successfully.',
    receipts_save_error: 'Failed to save receipt.',
    receipts_no_items_to_save: 'Add at least one line item before saving.',
    receipts_pdf_default_title: 'Receipt',
    receipts_pdf_heading: '領収書 (Receipt)',
    receipts_fetch_error: 'Failed to load receipt.',
    receipts_delete_button: 'Delete',
    receipts_delete_confirm: 'Delete this receipt?',
    receipts_delete_error: 'Failed to delete receipt.',
    report_heading: '📈 Summary Report',
    report_start: 'Start',
    report_end: 'End',
    report_jobs: 'Jobs',
    report_hint: 'Hold Ctrl/Cmd to select multiple jobs.',
    report_run: '▶ Run',
    report_income: 'Income (Wages)',
    report_expense: 'Expenses',
    report_net: 'Net',
    report_income_job: 'Income by Job',
    report_expense_category: 'Expenses by Category',
    period_title: '📊 Period Snapshots',
    period_week: 'This Week',
    period_month: 'This Month',
    period_year: 'This Year',
    period_income: 'Income',
    period_expense: 'Expenses',
    period_net: 'Net',
    profile_back: '⬅ Back to App',
    settings_basic_title: '⚙️ Basic Settings',
    settings_account_title: '🛡️ Account Settings',
    settings_default_wage: 'Default Hourly Wage',
    settings_default_shift: 'Default Shift Type',
    settings_autosave_label: 'Auto-save Calculations',
    settings_autosave_hint: 'Automatically save each calculation',
    settings_save_button: '💾 Save Settings',
    settings_change_email_title: 'Change Email',
    settings_change_password_title: 'Change Password',
    settings_new_email: 'New Email',
    settings_new_password: 'New Password',
    settings_confirm_password: 'Confirm New Password',
    settings_current_password: 'Current Password',
    settings_current_password_required: 'Please enter your current password.',
    settings_email_updated: 'Email updated successfully.',
    settings_invalid_email: 'Please enter a valid email.',
    settings_update_email_button: '✉️ Update Email',
    settings_update_password_button: '🔐 Update Password',
    settings_update_failed: 'Update failed. Please try again.',
    settings_password_length_error: 'Password must be at least 8 characters.',
    settings_password_mismatch: 'Passwords do not match.',
    settings_password_updated: 'Password updated successfully.',
    theme_dark: '🌙 Dark',
    theme_light: '☀️ Light',
    chart_income: 'Income',
    chart_expense: 'Expenses'
  },
  ja: {
    header_title: '💰 PayFlow — 給与と支出マネージャー',
    language_label: '🌐 言語',
    lang_en: '英語',
    lang_ja: '日本語',
    lang_my: 'ミャンマー語',
    lang_zh: '中国語',
    nav_menu_label: '📂 メニュー',
    nav_calculator: '📊 計算機',
    nav_calendar: '🗓️ カレンダー',
    nav_history: '📋 履歴',
    nav_jobs: '🏢 仕事',
    nav_expenses: '🧾 支出',
    nav_budget: '🎯 予算',
    nav_reports: '📈 レポート',
    nav_receipts: '🧾 領収書',
    nav_settings: '⚙️ 設定',
    nav_advanced: '🔧 詳細設定',
    nav_profile: '👤 プロフィール',
    history_heading: '📋 シフト履歴',
    history_export_pdf: '📄 PDF',
    history_export_csv: '📊 CSV',
    history_export_csv_server: '📊 CSV（サーバー）',
    history_col_date: '日付',
    history_col_job: '仕事',
    history_col_type: 'タイプ',
    history_col_start: '開始',
    history_col_end: '終了',
    history_col_break: '休憩',
    history_col_total_time: '合計時間',
    history_col_hourly: '時給',
    history_col_total: '合計賃金',
    history_col_actions: '操作',
    history_empty: 'まだシフト記録がありません。最初のシフトを計算しましょう！',
    summary_total_records: '総レコード数',
    jobs_heading: '🏢 仕事',
    jobs_label_name: '仕事名',
    jobs_label_wage: '既定の時給',
    jobs_label_currency: '通貨',
    jobs_label_color: '色',
    jobs_add_button: '➕ 仕事を追加',
    jobs_col_id: 'ID',
    jobs_col_name: '名称',
    jobs_col_wage: '賃金',
    jobs_col_currency: '通貨',
    jobs_col_color: '色',
    jobs_col_actions: '操作',
    jobs_empty: '仕事がまだありません。',
    expenses_heading: '🧾 支出',
    expenses_label_category: 'カテゴリ',
    expenses_label_amount: '金額',
    expenses_label_note: 'メモ',
    expenses_add_button: '➕ 追加',
    period_today: '今日',
    category_food: '食費',
    category_transportation: '交通費',
    category_shopping: 'ショッピング',
    category_bills: '公共料金',
    category_other: 'その他',
    expenses_col_date: '日付',
    expenses_col_category: 'カテゴリ',
    expenses_col_description: '説明',
    expenses_col_amount: '金額',
    expenses_col_actions: '操作',
    expenses_empty: '支出がまだありません。',
    action_delete: '削除',
    action_open: '開く',
    action_refresh: '再読み込み',
    action_remove: '削除',
    main_shift_details: '📝 シフト詳細',
    label_job: '仕事',
    hint_job_select: 'デフォルトの時給と通貨を自動入力するには仕事を選択してください。',
    label_date: '日付',
    label_start_time: '開始時刻',
    label_end_time: '終了時刻',
    label_break_start: '休憩開始',
    label_break_end: '休憩終了',
    label_shift_type: 'シフト種別',
    label_hourly_wage: '時給',
    shift_part_time: 'パートタイム',
    shift_full_time: 'フルタイム',
    shift_day: '日勤',
    shift_night: '夜勤',
    btn_calculate: '🧮 賃金を計算',
    results_heading: '💵 結果',
    budget_heading: '🎯 予算と目標',
    budget_month_label: '月',
    budget_refresh: '🔄',
    budget_category_label: 'カテゴリ',
    budget_amount_label: '月間予算',
    budget_save_button: '💾 予算を保存',
    budget_empty: 'まだ予算がありません。',
    budget_alert_near: '注意！{category} の支出が予算 {amount} の {percent}% に達しました。',
    budget_alert_over: '警告！{category} の支出が予算 {amount} を超えました。',
    calendar_heading: '🗓️ カレンダー概要',
    calendar_day_sun: '日',
    calendar_day_mon: '月',
    calendar_day_tue: '火',
    calendar_day_wed: '水',
    calendar_day_thu: '木',
    calendar_day_fri: '金',
    calendar_day_sat: '土',
    calendar_legend_heading: '凡例',
    calendar_shifts_heading: 'シフト',
    calendar_expenses_heading: '支出',
    calendar_details_none: 'この日に予定はありません。',
    receipts_builder_heading: '📑 領収書作成ツール',
    receipts_builder_subtitle: '明細を追加して領収書を作成できます。',
    receipts_title_label: '領収書タイトル',
    receipts_date_label: '領収書日付',
    receipts_note_label: '備考',
    receipts_add_line_button: '➕ 明細を追加',
    receipts_line_date: '日付',
    receipts_line_category: 'カテゴリ',
    receipts_line_description: '説明',
    receipts_line_quantity: '数量',
    receipts_line_unit_price: '単価',
    receipts_line_tax: '税率 %',
    receipts_line_total: '合計',
    receipts_line_validation: '数量・単価・税率は0より大きい値で入力してください。',
    receipts_no_items: '明細がまだありません。上のフォームから追加してください。',
    receipts_subtotal_label: '小計',
    receipts_tax_label: '税額',
    receipts_grand_label: '合計',
    receipts_clear_button: '♻️ クリア',
    receipts_save_button: '💾 領収書を保存',
    receipts_download_button: '📄 PDFをダウンロード',
    receipts_pdf_font_warning: '日本語フォントを読み込めませんでした。PDFの文字が正しく表示されない可能性があります。',
    receipts_empty: '保存された領収書はまだありません。',
    receipts_saved_heading: '保存済みの領収書',
    receipts_saved_amount: '金額',
    receipts_saved_created: '保存日',
    receipts_items_label: '件',
    receipts_save_success: '領収書を保存しました。',
    receipts_save_error: '領収書の保存に失敗しました。',
    receipts_no_items_to_save: '保存する前に明細を追加してください。',
    receipts_pdf_default_title: '領収書',
    receipts_pdf_heading: '領収書 (Receipt)',
    receipts_fetch_error: '領収書の読み込みに失敗しました。',
    receipts_delete_button: '削除',
    receipts_delete_confirm: 'この領収書を削除しますか？',
    receipts_delete_error: '領収書の削除に失敗しました。',
    report_heading: '📈 サマリーレポート',
    report_start: '開始',
    report_end: '終了',
    report_jobs: '仕事',
    report_hint: '複数選択するには Ctrl/Cmd を押しながらクリック。',
    report_run: '▶ 実行',
    report_income: '収入（賃金）',
    report_expense: '支出',
    report_net: '差引',
    report_income_job: '仕事別収入',
    report_expense_category: 'カテゴリ別支出',
    period_title: '📊 期間サマリー',
    period_week: '今週',
    period_month: '今月',
    period_year: '今年',
    period_income: '収入',
    period_expense: '支出',
    period_net: '差引',
    profile_back: '⬅ アプリへ戻る',
    settings_basic_title: '⚙️ 基本設定',
    settings_account_title: '🛡️ アカウント設定',
    settings_default_wage: '既定の時給',
    settings_default_shift: '既定のシフト区分',
    settings_autosave_label: '計算を自動保存',
    settings_autosave_hint: '計算結果を自動的に保存します',
    settings_save_button: '💾 設定を保存',
    settings_change_email_title: 'メールアドレスを変更',
    settings_change_password_title: 'パスワードを変更',
    settings_new_email: '新しいメールアドレス',
    settings_new_password: '新しいパスワード',
    settings_confirm_password: '新しいパスワード（確認）',
    settings_current_password: '現在のパスワード',
    settings_current_password_required: '現在のパスワードを入力してください。',
    settings_email_updated: 'メールアドレスを更新しました。',
    settings_invalid_email: '正しいメールアドレスを入力してください。',
    settings_update_email_button: '✉️ メールを更新',
    settings_update_password_button: '🔐 パスワードを更新',
    settings_update_failed: '更新に失敗しました。もう一度お試しください。',
    settings_password_length_error: 'パスワードは8文字以上で入力してください。',
    settings_password_mismatch: 'パスワードが一致しません。',
    settings_password_updated: 'パスワードを更新しました。',
    theme_dark: '🌙 ダーク',
    theme_light: '☀️ ライト',
    chart_income: '収入',
    chart_expense: '支出'
  },
  my: {
    header_title: '💰 PayFlow — လစာနှင့် ကုန်ကျစရိတ် စီမံခန့်ခွဲမှု',
    language_label: '🌐 ဘာသာစကား',
    lang_en: 'အင်္ဂလိပ်',
    lang_ja: 'ဂျပန်',
    lang_my: 'မြန်မာ',
    lang_zh: 'တရုတ်',
    nav_menu_label: '📂 မီနူး',
    nav_calculator: '📊 တွက်ချက်ခြင်း',
    nav_calendar: '🗓️ ပြက္ခဒိန်',
    nav_history: '📋 မှတ်တမ်း',
    nav_jobs: '🏢 အလုပ်များ',
    nav_expenses: '🧾 ကုန်ကျစရိတ်များ',
    nav_budget: '🎯 ဘတ်ဂျက်',
    nav_reports: '📈 အစီရင်ခံစာများ',
    nav_receipts: '🧾 လက်ခံလွှာများ',
    nav_settings: '⚙️ ဆက်တင်များ',
    nav_advanced: '🔧 အဆင့်မြင့်',
    nav_profile: '👤 ကိုယ်ရေး',
    history_heading: '📋 အလုပ်မှတ်တမ်း',
    history_export_pdf: '📄 PDF',
    history_export_csv: '📊 CSV',
    history_export_csv_server: '📊 CSV (ဆာဗာ)',
    history_col_date: 'ရက်စွဲ',
    history_col_job: 'အလုပ်',
    history_col_type: 'အမျိုးအစား',
    history_col_start: 'စတင်',
    history_col_end: 'အဆုံး',
    history_col_break: 'အပန်း',
    history_col_total_time: 'စုစုပေါင်း အချိန်',
    history_col_hourly: 'နာရီလစာ',
    history_col_total: 'စုစုပေါင်း လစာ',
    history_col_actions: 'လုပ်ဆောင်မှုများ',
    history_empty: 'အလုပ်မှတ်တမ်းမရှိသေးပါ။ ပထမဆုံးအလုပ်ကို တွက်ချက်ကြပါစို့!',
    summary_total_records: 'မှတ်တမ်းစုစုပေါင်း',
    jobs_heading: '🏢 အလုပ်များ',
    jobs_label_name: 'အလုပ်အမည်',
    jobs_label_wage: 'စံနာရီလစာ',
    jobs_label_currency: 'ငွေကြေး',
    jobs_label_color: 'အရောင်',
    jobs_add_button: '➕ အလုပ်ထည့်ပါ',
    jobs_col_id: 'ID',
    jobs_col_name: 'အမည်',
    jobs_col_wage: 'လစာ',
    jobs_col_currency: 'ငွေကြေး',
    jobs_col_color: 'အရောင်',
    jobs_col_actions: 'လုပ်ဆောင်မှုများ',
    jobs_empty: 'အလုပ်မရှိသေးပါ။',
    expenses_heading: '🧾 အသုံးစရိတ်များ',
    expenses_label_category: 'အမျိုးအစား',
    expenses_label_amount: 'ပမာဏ',
    expenses_label_note: 'မှတ်ချက်',
    expenses_add_button: '➕ ထည့်ရန်',
    period_today: 'ယနေ့',
    category_food: 'အစားအသောက်',
    category_transportation: 'ယာဉ်အသုံး',
    category_shopping: 'ဝယ်ယူမှု',
    category_bills: 'မီတာခများ',
    category_other: 'အခြား',
    expenses_col_date: 'ရက်စွဲ',
    expenses_col_category: 'အမျိုးအစား',
    expenses_col_description: 'ဖော်ပြချက်',
    expenses_col_amount: 'ပမာဏ',
    expenses_col_actions: 'လုပ်ဆောင်မှုများ',
    expenses_empty: 'အသုံးစရိတ်များမရှိသေးပါ။',
    action_delete: 'ဖျက်ရန်',
    action_open: 'ဖွင့်ရန်',
    action_refresh: 'ပြန်လည်အသစ်လုပ်ရန်',
    action_remove: 'ဖယ်ရှားရန်',
    main_shift_details: '📝 အလုပ်အသေးစိတ်',
    label_job: 'အလုပ်',
    hint_job_select: 'လစာနှုန်းနှင့် ငွေကြေးကို အလိုအလျောက်ဖြည့်ရန် အလုပ်ကို ရွေးပါ။',
    label_date: 'ရက်စွဲ',
    label_start_time: 'စတင်ချိန်',
    label_end_time: 'အဆုံးချိန်',
    label_break_start: 'အပန်းစ',
    label_break_end: 'အပန်းဆုံး',
    label_shift_type: 'အလုပ်ပုံစံ',
    label_hourly_wage: 'နာရီလစာ',
    shift_part_time: 'အချိန်ပိုင်း',
    shift_full_time: 'အချိန်ပြည့်',
    shift_day: 'နေ့အလုပ်',
    shift_night: 'ညအလုပ်',
    btn_calculate: '🧮 လစာတွက်ချက်',
    results_heading: '💵 ရလဒ်',
    budget_heading: '🎯 ဘတ်ဂျက်နှင့် ရည်မှန်းချက်များ',
    budget_month_label: 'လ',
    budget_refresh: '🔄',
    budget_category_label: 'အမျိုးအစား',
    budget_amount_label: 'လစဉ် ဘတ်ဂျက်',
    budget_save_button: '💾 ဘတ်ဂျက် သိမ်းဆည်း',
    budget_empty: 'ဘတ်ဂျက်မရှိသေးပါ။',
    budget_alert_near: 'သတိထားပါ! {category} အသုံးစရိတ်သည် ဘတ်ဂျက် {amount} ၏ {percent}% သို့ ရောက်နေပါသည်။',
    budget_alert_over: 'အရေးကြီး! {category} အသုံးစရိတ်သည် ဘတ်ဂျက် {amount} ကိုကျော်လွန်သွားပါပြီ။',
    calendar_heading: '🗓️ ပြက္ခဒိန် အမြင်',
    calendar_day_sun: 'တနင်္ဂနွေ',
    calendar_day_mon: 'တနင်္လာ',
    calendar_day_tue: 'အင်္ဂါ',
    calendar_day_wed: 'ဗုဒ္ဓဟူး',
    calendar_day_thu: 'ကြာသပတေး',
    calendar_day_fri: 'သောကြာ',
    calendar_day_sat: 'စနေ',
    calendar_legend_heading: 'အညွှန်း',
    calendar_shifts_heading: 'အလုပ်အမျိုးအစားများ',
    calendar_expenses_heading: 'အသုံးစရိတ်များ',
    calendar_details_none: 'ဒီနေ့အတွက် မှတ်တမ်းမရှိပါ။',
    receipts_builder_heading: '📑 လက်ခံလွှာ တည်ဆောက်ကိရိယာ',
    receipts_builder_subtitle: 'စာရင်းပုဒ်များထည့်၍ လက်ခံလွှာ ဖန်တီးပါ။',
    receipts_title_label: 'လက်ခံလွှာ ခေါင်းစဉ်',
    receipts_date_label: 'လက်ခံရက်',
    receipts_note_label: 'မှတ်ချက်',
    receipts_add_line_button: '➕ စာရင်းပုဒ် ထည့်ရန်',
    receipts_line_date: 'ရက်စွဲ',
    receipts_line_category: 'အမျိုးအစား',
    receipts_line_description: 'ဖော်ပြချက်',
    receipts_line_quantity: 'အရေအတွက်',
    receipts_line_unit_price: 'ယူနစ် စျေးနှုန်း',
    receipts_line_tax: 'အခွန် %',
    receipts_line_total: 'စုစုပေါင်း',
    receipts_line_validation: 'အရေအတွက်၊ စျေးနှုန်းနှင့် အခွန်ကိန်းများသည် အပြိုင် ဂဏန်းဖြစ်ရပါသည်။',
    receipts_no_items: 'စာရင်းပုဒ်မရှိသေးပါ။ အထက်မှ ထည့်ပါ။',
    receipts_subtotal_label: 'အောက်ပိုင်းစုစုပေါင်း',
    receipts_tax_label: 'အခွန်',
    receipts_grand_label: 'စုစုပေါင်း',
    receipts_clear_button: '♻️ ရှင်းလင်း',
    receipts_save_button: '💾 လက်ခံလွှာ သိမ်းဆည်း',
    receipts_download_button: '📄 PDF ဒေါင်းလုဒ်',
    receipts_pdf_font_warning: 'ဂျပန်ဖောင့်ကို ရယူမရနိုင်ပါ။ PDF စာတန်းများ မမှန်ကန်စွာ ပေါ်ပလာနိုင်သည်။',
    receipts_empty: 'သိမ်းဆည်းထားသော လက်ခံလွှာ မရှိသေးပါ။',
    receipts_saved_heading: 'သိမ်းဆည်းထားသော လက်ခံလွှာများ',
    receipts_saved_amount: 'ပမာဏ',
    receipts_saved_created: 'သိမ်းဆည်းသည့်နေ့',
    receipts_items_label: 'ခု',
    receipts_save_success: 'လက်ခံလွှာကို သိမ်းဆည်းပြီးပါပြီ။',
    receipts_save_error: 'လက်ခံလွှာ သိမ်းခြင်း မအောင်မြင်ပါ။',
    receipts_no_items_to_save: 'သိမ်းဆည်းရန် စာရင်းပုဒ်ထည့်ပါ။',
    receipts_pdf_default_title: 'လက်ခံလွှာ',
    receipts_pdf_heading: 'လက်ခံလွှာ (Receipt)',
    receipts_fetch_error: 'လက်ခံလွှာ မရရှိနိုင်ပါ။',
    receipts_delete_button: 'ဖျက်ရန်',
    receipts_delete_confirm: 'ဒီလက်ခံလွှာကို ဖျက်မှာ သေချာပါသလား။',
    receipts_delete_error: 'ဖျက်ခြင်း မအောင်မြင်ပါ။',
    report_heading: '📈 အကျဉ်းချုံး အစီရင်ခံစာ',
    report_start: 'စတင်ရက်',
    report_end: 'ဆုံးရက်',
    report_jobs: 'အလုပ်များ',
    report_hint: 'အများကြီးရွေးချယ်ရန် Ctrl/Cmd ကိုဖိထားပြီး ရွေးပါ။',
    report_run: '▶ လုပ်ဆောင်ပါ',
    report_income: 'ဝင်ငွေ (လစာ)',
    report_expense: 'အသုံးစရိတ်',
    report_net: 'ရှင်းလင်းငွေ',
    report_income_job: 'အလုပ်အလိုက် ဝင်ငွေ',
    report_expense_category: 'အမျိုးအစားအလိုက် အသုံးစရိတ်',
    period_title: '📊 ကာလအလိုက် အချက်အလက်',
    period_week: 'ယခုအပတ်',
    period_month: 'ယခုလ',
    period_year: 'ယခုနှစ်',
    period_income: 'ဝင်ငွေ',
    period_expense: 'အသုံးစရိတ်',
    period_net: 'ရှင်းလင်းငွေ',
    profile_back: '⬅ အက်ပ်သို့ ပြန်သွားရန်',
    settings_basic_title: '⚙️ မူလ ဆက်တင်များ',
    settings_account_title: '🛡️ အကောင့်ဆက်တင်',
    settings_default_wage: 'စံ နာရီလစာ',
    settings_default_shift: 'စံ အလုပ်အမျိုးအစား',
    settings_autosave_label: 'တွက်ချက်မှုများကို အလိုအလျောက် သိမ်းဆည်းရန်',
    settings_autosave_hint: 'တွက်ချက်ထားသမျှကို အလိုအလျောက် သိမ်းဆည်းပေးမည်',
    settings_save_button: '💾 ဆက်တင် သိမ်းဆည်း',
    settings_change_email_title: 'အီးမေးလ် ပြောင်းလဲရန်',
    settings_change_password_title: 'စကားဝှက်ပြောင်းရန်',
    settings_new_email: 'အီးမေးလ်အသစ်',
    settings_new_password: 'စကားဝှက်အသစ်',
    settings_confirm_password: 'စကားဝှက်အသစ် အတည်ပြုရန်',
    settings_current_password: 'လက်ရှိ စကားဝှက်',
    settings_current_password_required: 'လက်ရှိ စကားဝှက်ကို ထည့်ပါ။',
    settings_email_updated: 'အီးမေးလ်ကို အောင်မြင်စွာ ပြင်ဆင်ခဲ့ပါသည်။',
    settings_invalid_email: 'မှန်ကန်သော အီးမေးလ်ကို ထည့်ပါ။',
    settings_update_email_button: '✉️ အီးမေးလ် ပြောင်းလဲ',
    settings_update_password_button: '🔐 စကားဝှက် ပြောင်းလဲ',
    settings_update_failed: 'ပြင်ဆင်မှု မအောင်မြင်ပါ။ ထပ်မံကြိုးစားပါ။',
    settings_password_length_error: 'စကားဝှက်သည် အနည်းဆုံး အက္ခရာ 8 လုံးလိုအပ်ပါသည်။',
    settings_password_mismatch: 'စကားဝှက်နှစ်ခု မကိုက်ညီပါ။',
    settings_password_updated: 'စကားဝှက်ကို ပြန်လည်ပြောင်းလဲပြီးပါပြီ။',
    theme_dark: '🌙 မှောင်မိုမို',
    theme_light: '☀️ အလင်းရောင်',
    chart_income: 'ဝင်ငွေ',
    chart_expense: 'အသုံးစရိတ်'
  },
  zh: {
    header_title: '💰 PayFlow — 薪资与支出管理器',
    language_label: '🌐 语言',
    lang_en: '英语',
    lang_ja: '日语',
    lang_my: '缅甸语',
    lang_zh: '中文',
    nav_menu_label: '📂 菜单',
    nav_calculator: '📊 计算器',
    nav_calendar: '🗓️ 日历',
    nav_history: '📋 历史',
    nav_jobs: '🏢 工作',
    nav_expenses: '🧾 支出',
    nav_budget: '🎯 预算',
    nav_reports: '📈 报表',
    nav_receipts: '🧾 收据',
    nav_settings: '⚙️ 设置',
    nav_advanced: '🔧 高级',
    nav_profile: '👤 个人资料',
    history_heading: '📋 班次记录',
    history_export_pdf: '📄 PDF',
    history_export_csv: '📊 CSV',
    history_export_csv_server: '📊 CSV（服务器）',
    history_col_date: '日期',
    history_col_job: '工作',
    history_col_type: '类型',
    history_col_start: '开始',
    history_col_end: '结束',
    history_col_break: '休息',
    history_col_total_time: '总时长',
    history_col_hourly: '时薪',
    history_col_total: '总工资',
    history_col_actions: '操作',
    history_empty: '还没有班次记录，先计算一次班次吧！',
    summary_total_records: '记录总数',
    jobs_heading: '🏢 工作',
    jobs_label_name: '工作名称',
    jobs_label_wage: '默认时薪',
    jobs_label_currency: '货币',
    jobs_label_color: '颜色',
    jobs_add_button: '➕ 添加工作',
    jobs_col_id: '编号',
    jobs_col_name: '名称',
    jobs_col_wage: '工资',
    jobs_col_currency: '货币',
    jobs_col_color: '颜色',
    jobs_col_actions: '操作',
    jobs_empty: '暂无工作。',
    expenses_heading: '🧾 支出',
    expenses_label_category: '类别',
    expenses_label_amount: '金额',
    expenses_label_note: '备注',
    expenses_add_button: '➕ 添加',
    period_today: '今日',
    category_food: '餐饮',
    category_transportation: '交通',
    category_shopping: '购物',
    category_bills: '账单',
    category_other: '其他',
    expenses_col_date: '日期',
    expenses_col_category: '类别',
    expenses_col_description: '描述',
    expenses_col_amount: '金额',
    expenses_col_actions: '操作',
    expenses_empty: '暂无支出记录。',
    action_delete: '删除',
    action_open: '打开',
    action_refresh: '刷新',
    action_remove: '移除',
    main_shift_details: '📝 班次详情',
    label_job: '工作',
    hint_job_select: '选择工作以自动填充默认工资和货币。',
    label_date: '日期',
    label_start_time: '开始时间',
    label_end_time: '结束时间',
    label_break_start: '休息开始',
    label_break_end: '休息结束',
    label_shift_type: '班次类型',
    label_hourly_wage: '小时工资',
    shift_part_time: '兼职',
    shift_full_time: '全职',
    shift_day: '日班',
    shift_night: '夜班',
    btn_calculate: '🧮 计算工资',
    results_heading: '💵 结果',
    budget_heading: '🎯 预算与目标',
    budget_month_label: '月份',
    budget_refresh: '🔄',
    budget_category_label: '类别',
    budget_amount_label: '月预算',
    budget_save_button: '💾 保存预算',
    budget_empty: '尚未设置预算。',
    budget_alert_near: '提醒！{category} 支出已达到预算 {amount} 的 {percent}%。',
    budget_alert_over: '警告！{category} 支出已超过预算 {amount}。',
    calendar_heading: '🗓️ 日历概览',
    calendar_day_sun: '周日',
    calendar_day_mon: '周一',
    calendar_day_tue: '周二',
    calendar_day_wed: '周三',
    calendar_day_thu: '周四',
    calendar_day_fri: '周五',
    calendar_day_sat: '周六',
    calendar_legend_heading: '图例',
    calendar_shifts_heading: '班次',
    calendar_expenses_heading: '支出',
    calendar_details_none: '这一天没有安排。',
    receipts_builder_heading: '📑 收据生成器',
    receipts_builder_subtitle: '通过添加明细生成收据。',
    receipts_title_label: '收据标题',
    receipts_date_label: '收据日期',
    receipts_note_label: '备注',
    receipts_add_line_button: '➕ 添加明细',
    receipts_line_date: '日期',
    receipts_line_category: '类别',
    receipts_line_description: '说明',
    receipts_line_quantity: '数量',
    receipts_line_unit_price: '单价',
    receipts_line_tax: '税率 %',
    receipts_line_total: '金额',
    receipts_line_validation: '数量、单价和税率必须为正数。',
    receipts_no_items: '尚未添加明细，请先在上方填写。',
    receipts_subtotal_label: '小计',
    receipts_tax_label: '税额',
    receipts_grand_label: '总计',
    receipts_clear_button: '♻️ 清空',
    receipts_save_button: '💾 保存收据',
    receipts_download_button: '📄 下载 PDF',
    receipts_pdf_font_warning: '日文字体无法加载，PDF 文字可能显示异常。',
    receipts_empty: '暂无保存的收据。',
    receipts_saved_heading: '已保存的收据',
    receipts_saved_amount: '金额',
    receipts_saved_created: '保存时间',
    receipts_items_label: '条',
    receipts_save_success: '收据保存成功。',
    receipts_save_error: '收据保存失败。',
    receipts_no_items_to_save: '保存前请至少添加一条明细。',
    receipts_pdf_default_title: '收据',
    receipts_pdf_heading: '收据 (Receipt)',
    receipts_fetch_error: '收据加载失败。',
    receipts_delete_button: '删除',
    receipts_delete_confirm: '确定删除此收据吗？',
    receipts_delete_error: '删除收据失败。',
    report_heading: '📈 汇总报表',
    report_start: '开始',
    report_end: '结束',
    report_jobs: '工作',
    report_hint: '按住 Ctrl/Cmd 可多选工作。',
    report_run: '▶ 运行',
    report_income: '收入（工资）',
    report_expense: '支出',
    report_net: '净额',
    report_income_job: '按工作收入',
    report_expense_category: '按类别支出',
    period_title: '📊 周/月/年概览',
    period_week: '本周',
    period_month: '本月',
    period_year: '今年',
    period_income: '收入',
    period_expense: '支出',
    period_net: '净额',
    profile_back: '⬅ 返回应用',
    settings_basic_title: '⚙️ 基本设置',
    settings_account_title: '🛡️ 账户设置',
    settings_default_wage: '默认时薪',
    settings_default_shift: '默认班次类型',
    settings_autosave_label: '自动保存计算',
    settings_autosave_hint: '每次计算都会自动保存',
    settings_save_button: '💾 保存设置',
    settings_change_email_title: '修改邮箱',
    settings_change_password_title: '修改密码',
    settings_new_email: '新邮箱',
    settings_new_password: '新密码',
    settings_confirm_password: '确认新密码',
    settings_current_password: '当前密码',
    settings_current_password_required: '请输入当前密码。',
    settings_email_updated: '邮箱更新成功。',
    settings_invalid_email: '请输入有效的邮箱地址。',
    settings_update_email_button: '✉️ 更新邮箱',
    settings_update_password_button: '🔐 更新密码',
    settings_update_failed: '更新失败，请重试。',
    settings_password_length_error: '密码长度至少为 8 位。',
    settings_password_mismatch: '两次密码输入不一致。',
    settings_password_updated: '密码更新成功。',
    theme_dark: '🌙 深色',
    theme_light: '☀️ 浅色',
    chart_income: '收入',
    chart_expense: '支出'
  }
};

const onClick = (id, handler) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', handler);
};

const setText = (id, value) => {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
};

const getCurrencySymbol = () => {
  const curInput = document.getElementById('currency');
  if (curInput && curInput.value) return curInput.value;
  return settings.defaultCurrency || '¥';
};

const getTranslation = (key, lang = (settings.language || 'en')) => {
  const dict = translations[lang] || translations.en;
  return dict[key] || translations.en[key] || '';
};

function setThemeToggleLabel() {
  const btn = document.getElementById('themeToggle');
  if (!btn) return;
  const key = document.documentElement.classList.contains('dark') ? 'theme_light' : 'theme_dark';
  btn.textContent = getTranslation(key);
}

function applyTranslations(lang) {
  const dict = translations[lang] || translations.en;
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    if (!key) return;
    const value = dict[key] || translations.en[key];
    if (!value) return;
    if (['INPUT', 'TEXTAREA'].includes(el.tagName)) {
      el.placeholder = value;
    } else {
      el.textContent = value;
    }
  });
  setThemeToggleLabel();
}

function setLanguage(lang) {
  if (!translations[lang]) lang = 'en';
  settings.language = lang;
  localStorage.setItem('wageSettings', JSON.stringify(settings));
  const languageSelect = document.getElementById('languageSelect');
  if (languageSelect) languageSelect.value = lang;
  document.documentElement.setAttribute('lang', lang);
  applyTranslations(lang);
  // Refresh receipt UIs so dynamically rendered text switches languages too
  renderReceiptBuilder();
  renderSavedReceipts();
  if (lastReportPeriods) {
    updatePeriodSnapshots(lastReportPeriods, lastReportCurrency);
  }
  if (chartJob) {
    chartJob.data.datasets[0].label = getTranslation('chart_income', lang);
    chartJob.update();
  }
  if (chartCat) {
    chartCat.data.datasets[0].label = getTranslation('chart_expense', lang);
    chartCat.update();
  }
}

function ensureAuth(res) {
  if (res.status === 401) {
    alert('Your session has expired. Please log in again.');
    window.location.href = '/login';
    return false;
  }
  return true;
}

// ==============================
// Init
// ==============================
document.addEventListener('DOMContentLoaded', async function () {
  loadSettings();
  applyTranslations(settings.language || 'en');
  setupEventListeners();
  setCurrentDate();
  resetReceiptLineInputs();
  renderReceiptBuilder();
  updateProfileInfo();
  updatePeriodSnapshots({}, getCurrencySymbol());
  calendarState.current = new Date();
  calendarState.current.setDate(1);
  currentBudgetMonth = getMonthKey(calendarState.current);
  const budgetMonthInput = document.getElementById('budgetMonth');
  if (budgetMonthInput) budgetMonthInput.value = currentBudgetMonth;
  await loadJobs();             // load jobs first
  await loadShifts();           // then shifts
  await loadExpenses();         // then expenses
  await loadBudgets(currentBudgetMonth);
  await loadReceipts();
  updateHistorySummary();
  renderCalendar();
});

// ==============================
// UI: Page switching
// ==============================
function setupEventListeners() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', function () {
      showPage(this.dataset.page);
      closeMobileMenu();
    });
  });

  const languageSelect = document.getElementById('languageSelect');
  if (languageSelect) {
    languageSelect.value = settings.language || 'en';
    languageSelect.addEventListener('change', (e) => setLanguage(e.target.value));
  }

  onClick('mobileMenuToggle', toggleMobileMenu);
  onClick('calculateBtn', calculateWage);
  onClick('saveSettings', saveSettings);
  onClick('saveAdvanced', saveAdvancedSettings);
  onClick('themeToggle', toggleTheme);
  onClick('exportPDF', exportToPDF);
  onClick('exportCSV', exportToCSV);
  onClick('clearHistory', clearHistory);
  onClick('closeProfileBtn', () => showPage('main'));
  onClick('calendarPrev', () => changeCalendarMonth(-1));
  onClick('calendarNext', () => changeCalendarMonth(1));
  onClick('calendarDetailsClose', hideCalendarDetails);
  onClick('budgetRefresh', async () => {
    const monthInput = document.getElementById('budgetMonth');
    const selectedMonth = monthInput && monthInput.value ? monthInput.value : currentBudgetMonth;
    await loadBudgets(selectedMonth);
  });
  // Profile
  const profilePicInput = document.getElementById('profilePicInput');
  if (profilePicInput) {
    profilePicInput.addEventListener('change', function (e) {
      const file = e.target.files[0];
      if (file && file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = function (evt) {
          userProfile.pic = evt.target.result;
          localStorage.setItem('profilePic', userProfile.pic);
          updateProfileInfo();
        };
        reader.readAsDataURL(file);
      }
    });
  }
  const saveProfileBtn = document.getElementById('saveProfileBtn');
  if (saveProfileBtn) {
    saveProfileBtn.addEventListener('click', function () {
      const newName = document.getElementById('profileUsernameInput').value.trim() || 'Guest';
      const newEmail = document.getElementById('profileEmailInput').value.trim() || '-';
      userProfile.username = newName;
      userProfile.email = newEmail;
      localStorage.setItem('username', newName);
      localStorage.setItem('email', newEmail);
      if (!localStorage.getItem('profilePic')) {
        userProfile.pic = `https://ui-avatars.com/api/?name=${encodeURIComponent(newName)}`;
      }
      updateProfileInfo();
      alert('Profile updated!');
    });
  }

  // Jobs
  const addJobForm = document.getElementById('addJobForm');
  if (addJobForm) {
    addJobForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      await addJob();
    });
  }
  const refreshJobs = document.getElementById('refreshJobs');
  if (refreshJobs) {
    refreshJobs.addEventListener('click', async () => {
      await loadJobs();
      populateJobSelects();
    });
  }

  // Expenses
  const addExpenseForm = document.getElementById('addExpenseForm');
  if (addExpenseForm) {
    addExpenseForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      await addExpense();
    });
  }

  const changeEmailForm = document.getElementById('changeEmailForm');
  if (changeEmailForm) {
    changeEmailForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      await submitChangeEmail();
    });
  }

  const changePasswordForm = document.getElementById('changePasswordForm');
  if (changePasswordForm) {
    changePasswordForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      await submitChangePassword();
    });
  }

  const budgetForm = document.getElementById('budgetForm');
  if (budgetForm) {
    budgetForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      await saveBudget();
    });
  }

  const receiptLineForm = document.getElementById('receiptLineForm');
  if (receiptLineForm) {
    receiptLineForm.addEventListener('submit', (e) => {
      e.preventDefault();
      addReceiptLineItem();
    });
  }

  const receiptItemsBody = document.getElementById('receiptItemsBody');
  if (receiptItemsBody) {
    receiptItemsBody.addEventListener('click', handleReceiptItemsClick);
  }

  onClick('saveReceiptBtn', handleSaveReceipt);
  onClick('downloadReceiptPdf', downloadReceiptBuilderPdf);
  onClick('clearReceiptBtn', clearReceiptBuilder);
  onClick('refreshReceiptsBtn', loadReceipts);
  const savedReceipts = document.getElementById('savedReceipts');
  if (savedReceipts) {
    savedReceipts.addEventListener('click', handleSavedReceiptsClick);
  }

  const budgetMonthInput = document.getElementById('budgetMonth');
  if (budgetMonthInput) {
    budgetMonthInput.addEventListener('change', async (e) => {
      if (e.target.value) {
        await loadBudgets(e.target.value);
      }
    });
  }

  const budgetProgressList = document.getElementById('budgetProgressList');
  if (budgetProgressList) {
    budgetProgressList.addEventListener('click', handleBudgetListClick);
  }

  const calendarDetails = document.getElementById('calendarDetails');
  if (calendarDetails) {
    calendarDetails.addEventListener('click', handleCalendarDetailsAction);
  }

  // Reports
  const runReportBtn = document.getElementById('runReport');
  if (runReportBtn) {
    runReportBtn.addEventListener('click', runReport);
  }
}

function showPage(pageId) {
  document.querySelectorAll('.page').forEach(page => page.classList.add('hidden'));
  const activePage = document.getElementById(pageId + 'Page');
  if (activePage) activePage.classList.remove('hidden');

  document.querySelectorAll('.nav-btn').forEach(btn => {
    if (btn.dataset.page === pageId) {
      btn.classList.add('active', 'bg-blue-500', 'text-white');
      btn.classList.remove('bg-gray-200', 'text-gray-700');
    } else {
      btn.classList.remove('active', 'bg-blue-500', 'text-white');
      btn.classList.add('bg-gray-200', 'text-gray-700');
    }
  });

  if (pageId === 'calendar') renderCalendar();
  if (pageId === 'history') renderHistoryTable();
  if (pageId === 'jobs') renderJobsTable();
  if (pageId === 'expenses') renderExpensesTable();
  if (pageId === 'budget') {
    const monthInput = document.getElementById('budgetMonth');
    if (monthInput && monthInput.value !== currentBudgetMonth) {
      monthInput.value = currentBudgetMonth;
    }
    renderBudgetList();
    updateBudgetAlerts();
  }
  if (pageId === 'receipts') {
    renderReceiptBuilder();
    renderSavedReceipts();
  }
  if (pageId === 'profile') updateProfileInfo();
}

function toggleMobileMenu() {
  const menu = document.getElementById('navMenu');
  if (!menu) return;
  menu.classList.toggle('hidden');
}

function closeMobileMenu() {
  const menu = document.getElementById('navMenu');
  if (!menu) return;
  if (window.innerWidth < 768) {
    menu.classList.add('hidden');
  }
}

function updatePeriodSnapshots(periods = {}, currencyOverride) {
  const currencySymbol = currencyOverride || getCurrencySymbol();
  lastReportPeriods = JSON.parse(JSON.stringify(periods || {}));
  lastReportCurrency = currencySymbol;
  const format = (value) => `${currencySymbol}${Number(value || 0).toLocaleString()}`;
  const segments = ['week', 'month', 'year'];
  segments.forEach(segment => {
    const stats = periods[segment] || { income: 0, expense: 0, net: 0 };
    setText(`${segment}Income`, format(stats.income));
    setText(`${segment}Expense`, format(stats.expense));
    setText(`${segment}Net`, format(stats.net));
  });
}

// ==============================
// Settings & Theme
// ==============================
function loadSettings() {
  document.getElementById('defaultWage').value = settings.defaultWage;
  document.getElementById('defaultCurrency').value = settings.defaultCurrency;
  document.getElementById('defaultShiftType').value = settings.defaultShiftType;
  document.getElementById('autoSave').checked = settings.autoSave;
  document.getElementById('hourlyWage').value = settings.defaultWage;
  document.getElementById('currency').value = settings.defaultCurrency;
  document.getElementById('shiftType').value = settings.defaultShiftType;
  const languageSelect = document.getElementById('languageSelect');
  if (languageSelect) {
    languageSelect.value = settings.language || 'en';
  }
  document.documentElement.setAttribute('lang', settings.language || 'en');

  Object.keys(advancedSettings).forEach(key => {
    const el = document.getElementById(key);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = advancedSettings[key];
    else el.value = advancedSettings[key];
  });

  // theme
  if (settings.theme === 'dark') {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
  setThemeToggleLabel();
}

function saveSettings() {
  settings.defaultWage = parseFloat(document.getElementById('defaultWage').value) || 1200;
  settings.defaultCurrency = document.getElementById('defaultCurrency').value;
  settings.defaultShiftType = document.getElementById('defaultShiftType').value;
  settings.autoSave = document.getElementById('autoSave').checked;
  localStorage.setItem('wageSettings', JSON.stringify(settings));
  document.getElementById('hourlyWage').value = settings.defaultWage;
  document.getElementById('currency').value = settings.defaultCurrency;
  document.getElementById('shiftType').value = settings.defaultShiftType;
  alert('Settings saved!');
}

function saveAdvancedSettings() {
  Object.keys(advancedSettings).forEach(key => {
    const el = document.getElementById(key);
    if (!el) return;
    if (el.type === 'checkbox') advancedSettings[key] = el.checked;
    else advancedSettings[key] = el.value;
  });
  localStorage.setItem('advancedSettings', JSON.stringify(advancedSettings));
  alert('Advanced settings saved!');
}

async function submitChangeEmail() {
  const emailInput = document.getElementById('newEmailInput');
  const passwordInput = document.getElementById('currentPasswordForEmail');
  const messageEl = document.getElementById('changeEmailMessage');
  if (!emailInput || !passwordInput || !messageEl) return;
  clearInlineMessage(messageEl);
  const newEmail = emailInput.value.trim();
  const currentPassword = passwordInput.value;
  if (!isValidEmail(newEmail)) {
    showInlineMessage(messageEl, getTranslation('settings_invalid_email') || 'Please enter a valid email.', true);
    return;
  }
  if (!currentPassword) {
    showInlineMessage(messageEl, getTranslation('settings_current_password_required') || 'Please enter your current password.', true);
    return;
  }
  const res = await fetch('/account/change_email', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ new_email: newEmail, current_password: currentPassword })
  });
  if (!ensureAuth(res)) return;
  let payload = {};
  try {
    payload = await res.json();
  } catch (err) {
    payload = {};
  }
  if (res.ok && payload.success) {
    showInlineMessage(messageEl, getTranslation('settings_email_updated') || 'Email updated successfully.', false);
    userProfile.email = newEmail;
    localStorage.setItem('email', newEmail);
    sessionStorage.setItem('email', newEmail);
    updateProfileInfo();
    emailInput.value = '';
    passwordInput.value = '';
  } else {
    const errorMsg = payload.error || getTranslation('settings_update_failed') || 'Update failed. Please try again.';
    showInlineMessage(messageEl, errorMsg, true);
  }
}

async function submitChangePassword() {
  const currentInput = document.getElementById('currentPasswordInput');
  const newInput = document.getElementById('newPasswordInput');
  const confirmInput = document.getElementById('confirmPasswordInput');
  const messageEl = document.getElementById('changePasswordMessage');
  if (!currentInput || !newInput || !confirmInput || !messageEl) return;
  clearInlineMessage(messageEl);
  const currentPassword = currentInput.value;
  const newPassword = newInput.value;
  const confirmPassword = confirmInput.value;
  if (newPassword.length < 8) {
    showInlineMessage(messageEl, getTranslation('settings_password_length_error') || 'Password must be at least 8 characters.', true);
    return;
  }
  if (newPassword !== confirmPassword) {
    showInlineMessage(messageEl, getTranslation('settings_password_mismatch') || 'Passwords do not match.', true);
    return;
  }
  const res = await fetch('/account/change_password', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      current_password: currentPassword,
      new_password: newPassword,
      confirm_password: confirmPassword
    })
  });
  if (!ensureAuth(res)) return;
  let payload = {};
  try {
    payload = await res.json();
  } catch (err) {
    payload = {};
  }
  if (res.ok && payload.success) {
    showInlineMessage(messageEl, getTranslation('settings_password_updated') || 'Password updated successfully.', false);
    currentInput.value = '';
    newInput.value = '';
    confirmInput.value = '';
  } else {
    const errorMsg = payload.error || getTranslation('settings_update_failed') || 'Update failed. Please try again.';
    showInlineMessage(messageEl, errorMsg, true);
  }
}

function toggleTheme() {
  const html = document.documentElement;
  if (html.classList.contains('dark')) {
    html.classList.remove('dark');
    settings.theme = 'light';
  } else {
    html.classList.add('dark');
    settings.theme = 'dark';
  }
  localStorage.setItem('wageSettings', JSON.stringify(settings));
  setThemeToggleLabel();
}

// ==============================
// Profile UI
// ==============================
function updateProfileInfo() {
  const u = document.getElementById('profileUsername');
  const e = document.getElementById('profileEmail');
  const uInput = document.getElementById('profileUsernameInput');
  const eInput = document.getElementById('profileEmailInput');
  const pic = document.getElementById('profilePic');
  if (u) u.textContent = userProfile.username;
  if (e) e.textContent = userProfile.email;
  if (uInput) uInput.value = userProfile.username;
  if (eInput) eInput.value = userProfile.email;
  if (pic) pic.src = userProfile.pic;
}

// ==============================
// Dates
// ==============================
function setCurrentDate() {
  const today = new Date().toISOString().split('T')[0];
  const workDate = document.getElementById('workDate');
  if (workDate) workDate.value = today;
  const expDate = document.getElementById('expDate');
  if (expDate) expDate.value = today;
  const receiptDate = document.getElementById('receiptDate');
  if (receiptDate && !receiptDate.value) receiptDate.value = today;
  const lineDate = document.getElementById('lineDate');
  if (lineDate && !lineDate.value) lineDate.value = today;
}

// ==============================
// Jobs (CRUD)
// ==============================
async function loadJobs() {
  const res = await fetch('/api/jobs', { credentials: 'same-origin' });
  if (!ensureAuth(res)) {
    jobs = [];
    renderJobsTable();
    populateJobSelects();
    return;
  }
  if (res.ok) {
    jobs = await res.json();
  } else {
    jobs = [];
  }
  renderJobsTable();
  populateJobSelects();
}

function populateJobSelects() {
  const jobSelect = document.getElementById('jobSelect');
  const repJobs = document.getElementById('repJobs');
  if (jobSelect) {
    const previous = jobSelect.value;
    jobSelect.innerHTML = jobs.length
      ? jobs.map(j => `<option value="${j.id}" data-wage="${j.hourly_wage}" data-cur="${j.currency}" data-color="${j.color || '#4f46e5'}">${j.name}</option>`).join('')
      : `<option value="">${getTranslation('jobs_empty')}</option>`;
    jobSelect.onchange = onJobChange;
    if (jobs.length > 0) {
      const exists = jobs.some(j => String(j.id) === String(previous));
      jobSelect.value = exists ? previous : jobs[0].id;
      onJobChange();
    } else {
      jobSelect.value = '';
    }
  }
  if (repJobs) {
    repJobs.innerHTML = jobs.map(j => `<option value="${j.id}">${j.name}</option>`).join('');
  }
  updateCalendarLegend();
  renderCalendar();
}

function onJobChange() {
  const jobSelect = document.getElementById('jobSelect');
  if (!jobSelect) return;
  const selected = jobSelect.options[jobSelect.selectedIndex];
  if (!selected) return;
  const wage = selected.dataset.wage;
  const cur = selected.dataset.cur;
  if (wage) document.getElementById('hourlyWage').value = wage;
  if (cur) document.getElementById('currency').value = cur;
}

async function addJob() {
  const name = document.getElementById('jobName').value.trim();
  const hourly_wage = parseFloat(document.getElementById('jobWage').value || '1200');
  const currency = document.getElementById('jobCurrency').value;
  const color = document.getElementById('jobColor').value || '#4f46e5';
  if (!name) {
    alert('Please input job name.');
    return;
  }
  const res = await fetch('/api/jobs', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({name, hourly_wage, currency, color})
  });
  if (!ensureAuth(res)) return;
  if (res.ok) {
    await loadJobs();
    document.getElementById('addJobForm').reset();
    const colorInput = document.getElementById('jobColor');
    if (colorInput) colorInput.value = '#4f46e5';
    alert('Job added!');
  } else {
    alert('Failed to add job.');
  }
}

function renderJobsTable() {
  const tbody = document.getElementById('jobsTableBody');
  if (!tbody) return;
  if (jobs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="border p-6 text-center text-gray-500">${getTranslation('jobs_empty')}</td></tr>`;
    return;
  }
  const deleteLabel = getTranslation('action_delete');
  tbody.innerHTML = jobs.map(j => `
    <tr class="hover:bg-gray-50">
      <td class="border p-2">${j.id}</td>
      <td class="border p-2">${j.name}</td>
      <td class="border p-2">${j.hourly_wage}</td>
      <td class="border p-2">${j.currency}</td>
      <td class="border p-2">
        <span class="inline-flex items-center gap-2">
          <span class="inline-block h-4 w-4 rounded" style="background:${j.color || '#4f46e5'}"></span>
          <span class="text-xs text-gray-600">${j.color || '#4f46e5'}</span>
        </span>
      </td>
      <td class="border p-2">
        <button class="text-red-600 hover:underline" onclick="deleteJob(${j.id})">${deleteLabel}</button>
      </td>
    </tr>
  `).join('');
}

async function deleteJob(id) {
  if (!confirm('Delete this job? Shifts will remain but job link will be lost.')) return;
  const res = await fetch(`/api/jobs/${id}`, {
    method: 'DELETE',
    credentials: 'same-origin'
  });
  if (!ensureAuth(res)) return;
  if (res.ok) {
    await loadJobs();
    alert('Job deleted');
  } else {
    alert('Failed to delete');
  }
}

// ==============================
// Shifts (History)
// ==============================
async function loadShifts() {
  const res = await fetch('/api/shifts', { credentials: 'same-origin' });
  if (!ensureAuth(res)) {
    shiftHistory = [];
    renderHistoryTable();
    updateHistorySummary();
    return;
  }
  if (res.ok) {
    shiftHistory = await res.json();
  } else {
    shiftHistory = [];
  }
  renderHistoryTable();
  updateHistorySummary();
  renderCalendar();
}

function renderHistoryTable() {
  const tbody = document.getElementById('historyTableBody');
  if (!tbody) return;
  if (shiftHistory.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="10" class="border p-6 text-center text-gray-500">
          ${getTranslation('history_empty')}
        </td>
      </tr>`;
    return;
  }
  const deleteLabel = getTranslation('action_delete');
  tbody.innerHTML = shiftHistory.map(s => `
    <tr class="hover:bg-gray-50">
      <td class="border p-2">${s.date}</td>
      <td class="border p-2">${s.job_name || ''}</td>
      <td class="border p-2">${s.shift_type || ''}</td>
      <td class="border p-2">${s.start_time}</td>
      <td class="border p-2">${s.end_time}</td>
      <td class="border p-2">${s.break_start} - ${s.break_end}</td>
      <td class="border p-2">${s.total_hours}h</td>
      <td class="border p-2">${s.currency}${s.hourly_wage}</td>
      <td class="border p-2 font-semibold">${s.currency}${Number(s.total_wage).toLocaleString()}</td>
      <td class="border p-2">
        <button class="text-red-600 hover:underline" onclick="deleteShift(${s.id})">${deleteLabel}</button>
      </td>
    </tr>
  `).join('');
}

async function deleteShift(id) {
  if (!confirm('Delete this shift?')) return;
  const res = await fetch(`/api/shifts/${id}`, {
    method: 'DELETE',
    credentials: 'same-origin'
  });
  if (!ensureAuth(res)) return;
  if (res.ok) {
    await loadShifts();
    alert('Deleted');
  } else {
    alert('Failed to delete');
  }
}

function updateHistorySummary() {
  const now = new Date();
  const wStart = new Date(now); wStart.setDate(now.getDate() - now.getDay()); // Sunday
  const mStart = new Date(now.getFullYear(), now.getMonth(), 1);

  let weeklyTotal = 0;
  let monthlyTotal = 0;
  shiftHistory.forEach(shift => {
    const sd = new Date(shift.date);
    const total = Number(shift.total_wage || 0);
    if (sd >= wStart) weeklyTotal += total;
    if (sd >= mStart) monthlyTotal += total;
  });

  const symbol = getCurrencySymbol();
  document.getElementById('weeklyTotal').textContent = `${symbol}${weeklyTotal.toLocaleString()}`;
  document.getElementById('monthlyTotal').textContent = `${symbol}${monthlyTotal.toLocaleString()}`;
  document.getElementById('totalRecords').textContent = shiftHistory.length;
}

function clearHistory() {
  alert('This version does not mass-delete server records. Delete individually in the table.');
}

// ==============================
// Calendar
// ==============================
function changeCalendarMonth(offset) {
  if (!calendarState.current) {
    calendarState.current = new Date();
  }
  const current = calendarState.current;
  calendarState.current = new Date(current.getFullYear(), current.getMonth() + offset, 1);
  renderCalendar();
}

function renderCalendar() {
  const grid = document.getElementById('calendarGrid');
  const legend = document.getElementById('calendarLegend');
  if (!grid || !legend) return;

  if (!calendarState.current) {
    calendarState.current = new Date();
    calendarState.current.setDate(1);
  }
  updateCalendarLegend();
  const current = calendarState.current;
  current.setDate(1);

  const monthLabel = document.getElementById('calendarMonthLabel');
  if (monthLabel) {
    monthLabel.textContent = formatMonthLabel(current);
  }

  const todayIso = toISODate(new Date());
  const firstWeekday = new Date(current.getFullYear(), current.getMonth(), 1).getDay();
  const daysInMonth = new Date(current.getFullYear(), current.getMonth() + 1, 0).getDate();

  grid.innerHTML = '';

  const addPlaceholder = () => {
    const placeholder = document.createElement('div');
    placeholder.className = 'calendar-placeholder border border-dashed border-gray-200 rounded bg-gray-50';
    placeholder.setAttribute('aria-hidden', 'true');
    grid.appendChild(placeholder);
  };

  for (let i = 0; i < firstWeekday; i += 1) {
    addPlaceholder();
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const dateIso = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const dayShifts = shiftHistory.filter(s => s.date === dateIso);
    const dayExpenses = expenses.filter(e => e.date === dateIso);

    const cell = document.createElement('div');
    cell.className = 'calendar-cell border border-gray-200 rounded bg-white p-2 min-h-[110px] flex flex-col gap-2 cursor-pointer hover:shadow-sm transition';
    cell.dataset.date = dateIso;
    cell.setAttribute('tabindex', '0');

    if (dateIso === todayIso) {
      cell.classList.add('ring', 'ring-blue-200');
    }
    if (dayShifts.length === 0 && dayExpenses.length === 0) {
      cell.classList.add('calendar-cell--empty');
    }

    const header = document.createElement('div');
    header.className = 'flex items-center justify-between text-sm font-semibold text-gray-700';
    const dayNumber = document.createElement('span');
    dayNumber.textContent = day;
    header.appendChild(dayNumber);

    if (dayShifts.length > 0) {
      const wageTotal = dayShifts.reduce((acc, s) => acc + (parseFloat(s.total_wage) || 0), 0);
      const wageDisplay = document.createElement('span');
      wageDisplay.className = 'text-xs font-semibold text-blue-600';
      const symbol = dayShifts[0]?.currency || getCurrencySymbol();
      wageDisplay.textContent = `${symbol}${Math.round(wageTotal).toLocaleString()}`;
      header.appendChild(wageDisplay);
    }
    cell.appendChild(header);

    if (dayShifts.length > 0) {
      const shiftList = document.createElement('div');
      shiftList.className = 'flex flex-col gap-1';
      dayShifts.slice(0, 2).forEach(shift => {
        const shiftChip = document.createElement('div');
        shiftChip.className = 'text-xs text-white rounded px-2 py-1';
        shiftChip.style.background = shift.job_color || '#4f46e5';
        const jobName = shift.job_name || getTranslation('label_job');
        shiftChip.textContent = `${jobName} • ${shift.start_time} - ${shift.end_time}`;
        shiftList.appendChild(shiftChip);
      });
      if (dayShifts.length > 2) {
        const extra = document.createElement('span');
        extra.className = 'text-[11px] text-gray-500';
        extra.textContent = `+${dayShifts.length - 2} more`;
        shiftList.appendChild(extra);
      }
      cell.appendChild(shiftList);
    }

    if (dayExpenses.length > 0) {
      const iconRow = document.createElement('div');
      iconRow.className = 'flex flex-wrap gap-1 text-lg';
      dayExpenses.slice(0, 4).forEach(expense => {
        const icon = document.createElement('span');
        icon.textContent = expenseCategoryIcons[expense.category] || expenseCategoryIcons.other;
        iconRow.appendChild(icon);
      });
      if (dayExpenses.length > 4) {
        const extra = document.createElement('span');
        extra.className = 'text-xs text-gray-500';
        extra.textContent = `+${dayExpenses.length - 4}`;
        iconRow.appendChild(extra);
      }
      cell.appendChild(iconRow);
    }

    cell.addEventListener('click', () => showCalendarDetails(dateIso, dayShifts, dayExpenses));
    cell.addEventListener('keypress', (evt) => {
      if (evt.key === 'Enter' || evt.key === ' ') {
        evt.preventDefault();
        showCalendarDetails(dateIso, dayShifts, dayExpenses);
      }
    });

    grid.appendChild(cell);
  }

  while (grid.children.length % 7 !== 0) {
    addPlaceholder();
  }
}

function updateCalendarLegend() {
  const legend = document.getElementById('calendarLegend');
  if (!legend) return;
  const jobLegend = jobs.map(job => `
    <span class="inline-flex items-center gap-2 px-2 py-1 border border-gray-200 rounded text-xs">
      <span class="inline-block h-3 w-3 rounded" style="background:${job.color || '#4f46e5'}"></span>
      ${job.name}
    </span>
  `);
  const expenseLegend = Object.entries(expenseCategoryIcons).map(([key, icon]) => `
    <span class="inline-flex items-center gap-2 px-2 py-1 border border-gray-200 rounded text-xs">
      <span>${icon}</span>
      ${getCategoryLabel(key)}
    </span>
  `);
  legend.innerHTML = [...jobLegend, ...expenseLegend].join('');
}

function showCalendarDetails(dateIso, dayShifts, dayExpenses) {
  const panel = document.getElementById('calendarDetails');
  const dateLabel = document.getElementById('calendarDetailsDate');
  const shiftList = document.getElementById('calendarDetailsShifts');
  const expenseList = document.getElementById('calendarDetailsExpenses');
  if (!panel || !dateLabel || !shiftList || !expenseList) return;

  const dateObj = new Date(dateIso);
  try {
    dateLabel.textContent = dateObj.toLocaleDateString(settings.language || 'en', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  } catch (err) {
    dateLabel.textContent = `${dateIso}`;
  }

  const openLabel = getTranslation('action_open') || 'Open';
  const emptyLabel = getTranslation('calendar_details_none') || 'Nothing scheduled for this day yet.';

  shiftList.innerHTML = dayShifts.length
    ? dayShifts.map(shift => `
        <li class="border border-gray-200 rounded p-2 text-sm flex flex-col gap-1">
          <div class="flex items-center justify-between">
            <span class="font-semibold" style="color:${shift.job_color || '#4f46e5'}">${shift.job_name || 'Shift'}</span>
            <span class="text-xs text-gray-500">${shift.shift_type || ''}</span>
          </div>
          <div class="flex items-center justify-between text-xs text-gray-600">
            <span>${shift.start_time} - ${shift.end_time}</span>
            <span>${shift.currency || getCurrencySymbol()}${Number(shift.total_wage || 0).toLocaleString()}</span>
          </div>
          <button class="text-xs text-blue-600 hover:underline self-start" data-action="open-shift">${openLabel}</button>
        </li>
      `).join('')
    : `<li class="text-sm text-gray-500">${emptyLabel}</li>`;

  expenseList.innerHTML = dayExpenses.length
    ? dayExpenses.map(expense => `
        <li class="border border-gray-200 rounded p-2 text-sm flex flex-col gap-1">
          <div class="flex items-center justify-between">
            <span class="font-semibold">${expenseCategoryIcons[expense.category] || expenseCategoryIcons.other} ${getCategoryLabel(expense.category)}</span>
            <span class="text-xs text-gray-500">${expense.description || ''}</span>
          </div>
          <div class="flex items-center justify-between text-xs text-gray-600">
            <span>${expense.date}</span>
            <span>${getCurrencySymbol()}${Number(expense.amount || 0).toLocaleString()}</span>
          </div>
          <button class="text-xs text-blue-600 hover:underline self-start" data-action="open-expense">${openLabel}</button>
        </li>
      `).join('')
    : `<li class="text-sm text-gray-500">${emptyLabel}</li>`;

  panel.classList.remove('hidden');
}

function hideCalendarDetails() {
  const panel = document.getElementById('calendarDetails');
  if (panel) {
    panel.classList.add('hidden');
  }
}

function handleCalendarDetailsAction(event) {
  const btn = event.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === 'open-shift') {
    hideCalendarDetails();
    showPage('history');
  }
  if (action === 'open-expense') {
    hideCalendarDetails();
    showPage('expenses');
  }
}

// ==============================
// Expenses (CRUD + Dashboard)
// ==============================
async function loadExpenses() {
  const res = await fetch('/api/expenses', { credentials: 'same-origin' });
  if (!ensureAuth(res)) {
    expenses = [];
    renderExpensesTable();
    updateExpenseDashboard();
    renderCalendar();
    renderBudgetList();
    updateBudgetAlerts();
    return;
  }
  if (res.ok) {
    expenses = await res.json();
  } else {
    expenses = [];
  }
  renderExpensesTable();
  updateExpenseDashboard();
  renderCalendar();
  renderBudgetList();
  updateBudgetAlerts();
}

function renderExpensesTable() {
  const tbody = document.getElementById('expenseTableBody');
  if (!tbody) return;
  if (expenses.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="border p-6 text-center text-gray-500">${getTranslation('expenses_empty')}</td></tr>`;
    return;
  }
  const deleteLabel = getTranslation('action_delete');
  const symbol = getCurrencySymbol();
  tbody.innerHTML = expenses.map(e => `
    <tr class="hover:bg-gray-50">
      <td class="border p-2">${e.date}</td>
      <td class="border p-2">${e.category}</td>
      <td class="border p-2">${e.description || ''}</td>
      <td class="border p-2">${symbol}${Number(e.amount).toLocaleString()}</td>
      <td class="border p-2">
        <button class="text-red-600 hover:underline" onclick="deleteExpense(${e.id})">${deleteLabel}</button>
      </td>
    </tr>
  `).join('');
}

async function addExpense() {
  const date = document.getElementById('expDate').value;
  const category = document.getElementById('expCategory').value;
  const amount = parseFloat(document.getElementById('expAmount').value || '0');
  const description = document.getElementById('expDesc').value;
  if (!date || amount <= 0) {
    alert('Please enter date and a positive amount.');
    return;
  }
  const res = await fetch('/api/expenses', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({date, category, amount, description})
  });
  if (!ensureAuth(res)) return;
  if (res.ok) {
    await loadExpenses();
    document.getElementById('addExpenseForm').reset();
    setCurrentDate();
    alert('Expense added!');
  } else {
    alert('Failed to add expense.');
  }
}

async function deleteExpense(id) {
  if (!confirm('Delete this expense?')) return;
  const res = await fetch(`/api/expenses/${id}`, {
    method:'DELETE',
    credentials: 'same-origin'
  });
  if (!ensureAuth(res)) return;
  if (res.ok) {
    await loadExpenses();
  } else {
    alert('Failed to delete');
  }
}

function updateExpenseDashboard() {
  const today = new Date().toISOString().split('T')[0];
  const now = new Date();
  const weekStart = new Date(now); weekStart.setDate(now.getDate() - now.getDay());
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const yearStart = new Date(now.getFullYear(), 0, 1);

  let sumToday = 0, sumWeek = 0, sumMonth = 0, sumYear = 0;

  expenses.forEach(e => {
    const d = new Date(e.date);
    const a = Number(e.amount || 0);
    if (e.date === today) sumToday += a;
    if (d >= weekStart) sumWeek += a;
    if (d >= monthStart) sumMonth += a;
    if (d >= yearStart) sumYear += a;
  });

  const symbol = getCurrencySymbol();
  document.getElementById('expToday').textContent = `${symbol}${sumToday.toLocaleString()}`;
  document.getElementById('expWeek').textContent = `${symbol}${sumWeek.toLocaleString()}`;
  document.getElementById('expMonth').textContent = `${symbol}${sumMonth.toLocaleString()}`;
  document.getElementById('expYear').textContent = `${symbol}${sumYear.toLocaleString()}`;
}

// ==============================
// Budgets & Goals
// ==============================
async function loadBudgets(monthKey) {
  const targetMonth = monthKey || currentBudgetMonth || getMonthKey(new Date());
  currentBudgetMonth = targetMonth;
  const monthInput = document.getElementById('budgetMonth');
  if (monthInput && monthInput.value !== targetMonth) {
    monthInput.value = targetMonth;
  }
  const url = new URL('/api/budgets', window.location.origin);
  if (targetMonth) {
    url.searchParams.set('month', targetMonth);
  }
  const res = await fetch(url.toString(), { credentials: 'same-origin' });
  if (!ensureAuth(res)) {
    budgets = [];
    renderBudgetList();
    updateBudgetAlerts();
    return;
  }
  if (res.ok) {
    budgets = await res.json();
  } else {
    budgets = [];
  }
  renderBudgetList();
  updateBudgetAlerts();
}

async function saveBudget() {
  const category = document.getElementById('budgetCategory').value;
  const amount = parseFloat(document.getElementById('budgetAmount').value || '0');
  const monthInput = document.getElementById('budgetMonth');
  const month = (monthInput && monthInput.value) ? monthInput.value : getMonthKey(new Date());

  if (!category) {
    alert('Please pick a category.');
    return;
  }
  if (amount < 0) {
    alert('Budget must be zero or positive.');
    return;
  }

  const payload = { category, amount, month };
  const res = await fetch('/api/budgets', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload)
  });
  if (!ensureAuth(res)) return;
  if (res.ok) {
    document.getElementById('budgetForm').reset();
    if (monthInput) monthInput.value = month;
    await loadBudgets(month);
    alert('Budget saved!');
  } else {
    alert('Failed to save budget.');
  }
}

async function deleteBudget(id) {
  if (!confirm('Delete this budget goal?')) return;
  const res = await fetch(`/api/budgets/${id}`, {
    method: 'DELETE',
    credentials: 'same-origin'
  });
  if (!ensureAuth(res)) return;
  if (res.ok) {
    await loadBudgets(currentBudgetMonth);
  } else {
    alert('Failed to delete budget.');
  }
}

function handleBudgetListClick(event) {
  const btn = event.target.closest('[data-budget-action]');
  if (!btn) return;
  const id = btn.dataset.budgetId;
  if (!id) return;
  if (btn.dataset.budgetAction === 'delete') {
    deleteBudget(Number(id));
  }
}

function getMonthlyExpenseTotals(monthKey) {
  const totals = {};
  if (!monthKey) return totals;
  expenses.forEach(expense => {
    if (!expense.date || !expense.date.startsWith(monthKey)) return;
    const amount = Number(expense.amount || 0);
    totals[expense.category] = (totals[expense.category] || 0) + amount;
  });
  return totals;
}

function renderBudgetList() {
  const container = document.getElementById('budgetProgressList');
  if (!container) return;
  if (!budgets.length) {
    container.innerHTML = `<p class="text-sm text-gray-500">${getTranslation('budget_empty')}</p>`;
    return;
  }
  const totals = getMonthlyExpenseTotals(currentBudgetMonth || getMonthKey(new Date()));
  const currency = getCurrencySymbol();
  const deleteLabel = getTranslation('action_delete') || 'Delete';
  container.innerHTML = budgets.map(budget => {
    const spent = totals[budget.category] || 0;
    const amount = Number(budget.amount || 0);
    const percent = amount > 0 ? Math.min(100, Math.round((spent / amount) * 100)) : 0;
    let barColor = 'bg-green-500';
    if (percent >= 100) barColor = 'bg-red-500';
    else if (percent >= 80) barColor = 'bg-yellow-500';

    return `
      <div class="border border-gray-200 rounded-lg p-4 space-y-3" data-budget-id="${budget.id}">
        <div class="flex items-center justify-between">
          <div>
            <p class="text-sm font-semibold text-gray-700">${getCategoryLabel(budget.category)}</p>
            <p class="text-xs text-gray-500">${currency}${amount.toLocaleString()} target</p>
          </div>
          <button class="text-xs text-red-600 hover:underline" data-budget-action="delete" data-budget-id="${budget.id}">${deleteLabel}</button>
        </div>
        <div class="w-full bg-gray-100 h-3 rounded">
          <div class="h-3 rounded ${barColor}" style="width:${percent}%;"></div>
        </div>
        <div class="flex items-center justify-between text-xs text-gray-600">
          <span>${currency}${spent.toLocaleString()} spent</span>
          <span>${percent}%</span>
        </div>
      </div>
    `;
  }).join('');
}

function updateBudgetAlerts() {
  const alertBox = document.getElementById('budgetAlerts');
  if (!alertBox) return;
  if (!budgets.length) {
    alertBox.classList.add('hidden');
    alertBox.innerHTML = '';
    return;
  }
  const totals = getMonthlyExpenseTotals(currentBudgetMonth || getMonthKey(new Date()));
  const currency = getCurrencySymbol();
  const alertMessages = [];

  budgets.forEach(budget => {
    const amount = Number(budget.amount || 0);
    if (amount <= 0) return;
    const spent = totals[budget.category] || 0;
    const percent = amount > 0 ? (spent / amount) * 100 : 0;
    if (percent >= 100) {
      const template = getTranslation('budget_alert_over');
      alertMessages.push(formatTemplate(template, {
        category: getCategoryLabel(budget.category),
        amount: `${currency}${amount.toLocaleString()}`,
        percent: Math.round(percent)
      }));
    } else if (percent >= 80) {
      const template = getTranslation('budget_alert_near');
      alertMessages.push(formatTemplate(template, {
        category: getCategoryLabel(budget.category),
        amount: `${currency}${amount.toLocaleString()}`,
        percent: Math.round(percent)
      }));
    }
  });

  if (!alertMessages.length) {
    alertBox.classList.add('hidden');
    alertBox.innerHTML = '';
  } else {
    alertBox.classList.remove('hidden');
    alertBox.innerHTML = alertMessages.map(msg => `<p>${msg}</p>`).join('');
  }
}

// ==============================
// Receipts (Builder + PDF)
// ==============================
function computeReceiptSummary(items) {
  let subtotal = 0;
  let tax = 0;
  const detailed = items.map(item => {
    const quantity = Number(item.quantity) || 0;
    const unitPrice = Number(item.unit_price) || 0;
    const taxRate = Number(item.tax_rate) || 0;
    const base = quantity * unitPrice;
    const taxAmount = base * (taxRate / 100);
    subtotal += base;
    tax += taxAmount;
    return {
      date: item.date,
      category: item.category,
      description: item.description,
      quantity,
      unit_price: unitPrice,
      tax_rate: taxRate,
      line_total: base + taxAmount
    };
  });
  return {
    subtotal,
    tax,
    grand: subtotal + tax,
    detailed
  };
}

function formatCurrency(value) {
  const symbol = getCurrencySymbol();
  return `${symbol}${Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function setReceiptBuilderMessage(message, isError = true) {
  const messageEl = document.getElementById('receiptBuilderMessage');
  if (!message) {
    clearInlineMessage(messageEl);
    return;
  }
  showInlineMessage(messageEl, message, isError);
}

function renderReceiptBuilder() {
  const tbody = document.getElementById('receiptItemsBody');
  if (!tbody) return;
  const summary = computeReceiptSummary(receiptDraftItems);
  if (!summary.detailed.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="border px-3 py-4 text-center text-gray-500">${getTranslation('receipts_no_items') || 'No line items yet. Add your first item above.'}</td></tr>`;
  } else {
    const deleteLabel = getTranslation('action_remove') || 'Remove';
    tbody.innerHTML = summary.detailed.map((item, index) => `
      <tr>
        <td class="border px-2 py-2">${item.date || '-'}</td>
        <td class="border px-2 py-2">${getCategoryLabel(item.category)}</td>
        <td class="border px-2 py-2">${item.description || ''}</td>
        <td class="border px-2 py-2 text-right">${item.quantity}</td>
        <td class="border px-2 py-2 text-right">${Number(item.unit_price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        <td class="border px-2 py-2 text-right">${Number(item.tax_rate).toLocaleString(undefined, { maximumFractionDigits: 1 })}%</td>
        <td class="border px-2 py-2 text-right">${formatCurrency(item.line_total)}</td>
        <td class="border px-2 py-2 text-center">
          <button class="text-red-600 hover:underline" data-action="remove-line" data-index="${index}">${deleteLabel}</button>
        </td>
      </tr>
    `).join('');
  }
  const summaryCurrencySymbol = getCurrencySymbol();
  setText('receiptSubtotal', formatCurrency(summary.subtotal));
  setText('receiptTaxTotal', formatCurrency(summary.tax));
  setText('receiptGrandTotal', formatCurrency(summary.grand));
}

function resetReceiptLineInputs() {
  const lineDescription = document.getElementById('lineDescription');
  if (lineDescription) lineDescription.value = '';
  const lineQuantity = document.getElementById('lineQuantity');
  if (lineQuantity) lineQuantity.value = '1';
  const lineUnitPrice = document.getElementById('lineUnitPrice');
  if (lineUnitPrice) lineUnitPrice.value = '';
  const lineTaxRate = document.getElementById('lineTaxRate');
  if (lineTaxRate) lineTaxRate.value = '';
  const lineDate = document.getElementById('lineDate');
  if (lineDate && !lineDate.value) lineDate.value = new Date().toISOString().split('T')[0];
}

function addReceiptLineItem() {
  const lineDate = document.getElementById('lineDate');
  const lineCategory = document.getElementById('lineCategory');
  const lineDescription = document.getElementById('lineDescription');
  const lineQuantity = document.getElementById('lineQuantity');
  const lineUnitPrice = document.getElementById('lineUnitPrice');
  const lineTaxRate = document.getElementById('lineTaxRate');
  const quantity = Number(lineQuantity?.value || 0);
  const unitPrice = Number(lineUnitPrice?.value || 0);
  const taxRate = Number(lineTaxRate?.value || 0);
  if (quantity <= 0 || unitPrice < 0 || taxRate < 0) {
    setReceiptBuilderMessage(getTranslation('receipts_line_validation') || 'Quantity, price, and tax must be positive values.', true);
    return;
  }
  receiptDraftItems.push({
    date: lineDate?.value || '',
    category: lineCategory?.value || 'other',
    description: lineDescription?.value?.trim() || '',
    quantity,
    unit_price: unitPrice,
    tax_rate: taxRate
  });
  renderReceiptBuilder();
  resetReceiptLineInputs();
  setReceiptBuilderMessage(null);
}

function handleReceiptItemsClick(event) {
  const actionBtn = event.target.closest('[data-action]');
  if (!actionBtn) return;
  const action = actionBtn.dataset.action;
  const index = Number(actionBtn.dataset.index);
  if (action === 'remove-line' && !Number.isNaN(index)) {
    removeReceiptLine(index);
  }
}

function removeReceiptLine(index) {
  receiptDraftItems.splice(index, 1);
  renderReceiptBuilder();
}

function clearReceiptBuilder() {
  receiptDraftItems = [];
  const lineForm = document.getElementById('receiptLineForm');
  if (lineForm) lineForm.reset();
  const receiptTitle = document.getElementById('receiptTitle');
  if (receiptTitle) receiptTitle.value = '';
  const receiptDate = document.getElementById('receiptDate');
  if (receiptDate) receiptDate.value = new Date().toISOString().split('T')[0];
  const receiptNote = document.getElementById('receiptNote');
  if (receiptNote) receiptNote.value = '';
  resetReceiptLineInputs();
  renderReceiptBuilder();
  setReceiptBuilderMessage(null);
}

function getReceiptBuilderPayload() {
  const receiptTitle = document.getElementById('receiptTitle');
  const receiptDate = document.getElementById('receiptDate');
  const receiptNote = document.getElementById('receiptNote');
  const summary = computeReceiptSummary(receiptDraftItems);
  return {
    title: receiptTitle ? receiptTitle.value.trim() : '',
    date: receiptDate ? receiptDate.value : '',
    note: receiptNote ? receiptNote.value.trim() : '',
    summary,
    items: summary.detailed.map(item => ({
      date: item.date,
      category: item.category,
      description: item.description,
      quantity: item.quantity,
      unit_price: item.unit_price,
      tax_rate: item.tax_rate
    }))
  };
}

async function handleSaveReceipt() {
  const payload = getReceiptBuilderPayload();
  if (!payload.items.length) {
    setReceiptBuilderMessage(getTranslation('receipts_no_items_to_save') || 'Add at least one line item before saving.', true);
    return;
  }
  const res = await fetch('/api/receipts', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ title: payload.title, date: payload.date, note: payload.note, items: payload.items })
  });
  if (!ensureAuth(res)) return;
  let data = {};
  try {
    data = await res.json();
  } catch (err) {
    data = {};
  }
  if (res.ok && data.success) {
    setReceiptBuilderMessage(getTranslation('receipts_save_success') || 'Receipt saved successfully.', false);
    clearReceiptBuilder();
    await loadReceipts();
  } else {
    const error = data.error || getTranslation('receipts_save_error') || 'Failed to save receipt.';
    setReceiptBuilderMessage(error, true);
  }
}

async function downloadReceiptBuilderPdf() {
  const payload = getReceiptBuilderPayload();
  if (!payload.items.length) {
    setReceiptBuilderMessage(getTranslation('receipts_no_items_to_save') || 'Add at least one line item before saving.', true);
    return;
  }
  const data = {
    title: payload.title || getTranslation('receipts_pdf_default_title') || 'Receipt',
    date: payload.date,
    subtotal: payload.summary.subtotal,
    tax_total: payload.summary.tax,
    grand_total: payload.summary.grand,
    note: payload.note,
    items: payload.summary.detailed
  };
  await generateReceiptPdf(data, `receipt-${Date.now()}.pdf`);
}

async function loadReceipts() {
  const res = await fetch('/api/receipts', { credentials: 'same-origin' });
  if (!ensureAuth(res)) {
    receipts = [];
    renderSavedReceipts();
    return;
  }
  if (res.ok) {
    receipts = await res.json();
  } else {
    receipts = [];
  }
  renderSavedReceipts();
}

function renderSavedReceipts() {
  const container = document.getElementById('savedReceipts');
  if (!container) return;
  if (!receipts.length) {
    container.innerHTML = `<p class="text-sm text-gray-500">${getTranslation('receipts_empty') || 'No receipts saved yet.'}</p>`;
    return;
  }
  const downloadLabel = getTranslation('receipts_download_button') || 'Download PDF';
  const deleteLabel = getTranslation('receipts_delete_button') || 'Delete';
  const itemsLabel = getTranslation('receipts_items_label') || 'items';
  const noteLabel = getTranslation('receipts_note_label') || 'Note';
  container.innerHTML = receipts.map(receipt => `
    <div class="border border-gray-200 rounded-lg p-4 space-y-3">
      <div class="flex items-center justify-between">
        <div>
          <p class="font-semibold text-gray-800">${receipt.title || getTranslation('receipts_pdf_default_title') || 'Receipt'}</p>
          <p class="text-xs text-gray-500">${receipt.date || '-'}</p>
        </div>
        <span class="text-xs text-gray-500">${(receipt.items || []).length} ${itemsLabel}</span>
      </div>
      ${receipt.note ? `<p class="text-sm text-gray-600 whitespace-pre-wrap">${noteLabel}: ${receipt.note}</p>` : ''}
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm">
        <span>${getTranslation('receipts_subtotal_label') || 'Subtotal'}: <strong>${formatCurrency(receipt.subtotal)}</strong></span>
        <span>${getTranslation('receipts_tax_label') || 'Tax'}: <strong>${formatCurrency(receipt.tax_total)}</strong></span>
        <span>${getTranslation('receipts_grand_label') || 'Grand Total'}: <strong>${formatCurrency(receipt.grand_total)}</strong></span>
      </div>
      <div class="flex flex-wrap gap-3 text-sm">
        <button class="text-blue-600 hover:underline" data-action="download-receipt" data-id="${receipt.id}">${downloadLabel}</button>
        <button class="text-red-600 hover:underline" data-action="delete-receipt" data-id="${receipt.id}">${deleteLabel}</button>
      </div>
    </div>
  `).join('');
}

function handleSavedReceiptsClick(event) {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const receiptId = Number(target.dataset.id);
  if (Number.isNaN(receiptId)) return;
  const action = target.dataset.action;
  if (action === 'download-receipt') {
    downloadSavedReceipt(receiptId);
  } else if (action === 'delete-receipt') {
    deleteSavedReceipt(receiptId);
  }
}

async function downloadSavedReceipt(receiptId) {
  const res = await fetch(`/api/receipts/${receiptId}/pdf`, { credentials: 'same-origin' });
  if (!ensureAuth(res)) return;
  if (!res.ok) {
    alert(getTranslation('receipts_fetch_error') || 'Failed to load receipt.');
    return;
  }
  const data = await res.json();
  data.items = (data.items || []).map(item => ({
    date: item.date,
    category: item.category,
    description: item.description,
    quantity: Number(item.quantity) || 0,
    unit_price: Number(item.unit_price) || 0,
    tax_rate: Number(item.tax_rate) || 0,
    line_total: Number(item.line_total) || 0
  }));
  await generateReceiptPdf({
    title: data.title || getTranslation('receipts_pdf_default_title') || 'Receipt',
    date: data.date,
    subtotal: data.subtotal,
    tax_total: data.tax_total,
    grand_total: data.grand_total,
    note: data.note,
    items: data.items
  }, `receipt-${receiptId}.pdf`);
}

async function deleteSavedReceipt(receiptId) {
  const confirmMessage = getTranslation('receipts_delete_confirm') || 'Delete this receipt?';
  if (!window.confirm(confirmMessage)) return;
  const res = await fetch(`/api/receipts/${receiptId}`, {
    method: 'DELETE',
    credentials: 'same-origin'
  });
  if (!ensureAuth(res)) return;
  if (res.ok) {
    await loadReceipts();
  } else {
    alert(getTranslation('receipts_delete_error') || 'Failed to delete receipt.');
  }
}

async function generateReceiptPdf(data, filename) {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    alert('PDF library is not available.');
    return;
  }
  const fontReady = await ensureReceiptPdfFont();
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  let activeFont = 'helvetica';
  if (fontReady && receiptPdfFontBase64 && receiptPdfFontFileName) {
    try {
      doc.addFileToVFS(receiptPdfFontFileName, receiptPdfFontBase64);
      doc.addFont(receiptPdfFontFileName, receiptPdfFontId, 'normal');
      doc.setFont(receiptPdfFontId, 'normal');
      activeFont = receiptPdfFontId;
    } catch (err) {
      console.warn('[PDF] Failed to attach Japanese font to document instance.', err);
    }
  } else if (receiptPdfFontRegistered) {
    try {
      doc.setFont(receiptPdfFontId, 'normal');
      activeFont = receiptPdfFontId;
    } catch (err) {
      console.warn('[PDF] Registered font could not be set on document.', err);
    }
  } else {
    console.warn('[PDF] Japanese font is not available; falling back to default font.');
  }
  try {
    doc.setFont(activeFont, 'normal');
  } catch (err) {
    console.warn('[PDF] Active font could not be applied; defaulting to Helvetica.', err);
    doc.setFont('helvetica', 'normal');
    activeFont = 'helvetica';
  }
  const fontWarningMessage = getTranslation('receipts_pdf_font_warning') || 'Japanese font could not be loaded. PDF text may appear garbled.';
  const receiptBuilderMessageEl = document.getElementById('receiptBuilderMessage');
  if (!fontReady || activeFont !== receiptPdfFontId) {
    if (receiptBuilderMessageEl) {
      setReceiptBuilderMessage(fontWarningMessage, true);
    }
  } else if (receiptBuilderMessageEl && receiptBuilderMessageEl.textContent === fontWarningMessage) {
    setReceiptBuilderMessage(null);
  }
  const heading = getTranslation('receipts_pdf_heading') || '領収書 (Receipt)';
  doc.setFontSize(18);
  doc.text(heading, 14, 24);
  doc.setFontSize(12);
  doc.text(`${getTranslation('receipts_title_label') || 'Receipt Title'}: ${data.title || '-'}`, 14, 42);
  doc.text(`${getTranslation('receipts_date_label') || 'Receipt Date'}: ${data.date || '-'}`, 14, 58);
  const tableHead = [[
    getTranslation('receipts_line_date') || 'Date',
    getTranslation('receipts_line_category') || 'Category',
    getTranslation('receipts_line_description') || 'Description',
    getTranslation('receipts_line_quantity') || 'Qty',
    getTranslation('receipts_line_unit_price') || 'Unit Price',
    getTranslation('receipts_line_tax') || 'Tax %',
    getTranslation('receipts_line_total') || 'Line Total'
  ]];
  const body = (data.items || []).map(item => [
    item.date || '-',
    getCategoryLabel(item.category),
    item.description || '',
    item.quantity,
    Number(item.unit_price || 0).toFixed(2),
    Number(item.tax_rate || 0).toFixed(1),
    formatCurrency(item.line_total || 0)
  ]);
  let currentY = 74;
  if (data.note) {
    const noteLabel = getTranslation('receipts_note_label') || 'Note';
    const noteText = `${noteLabel}: ${data.note}`;
    const wrappedNote = doc.splitTextToSize(noteText, 180);
    doc.setFontSize(12);
    doc.text(wrappedNote, 14, currentY);
    currentY += wrappedNote.length * 6 + 10;
  }
  const pdfFontName = activeFont;
  if (doc.autoTable) {
    doc.autoTable({
      startY: currentY,
      head: tableHead,
      body,
      styles: { font: pdfFontName, fontSize: 10, fontStyle: 'normal', halign: 'right' },
      headStyles: { font: pdfFontName, fontStyle: 'normal', halign: 'center' },
      columnStyles: {
        0: { halign: 'left' },
        1: { halign: 'left' },
        2: { halign: 'left' }
      }
    });
    currentY = doc.lastAutoTable.finalY + 20;
  } else {
    doc.setFontSize(10);
    const rows = [tableHead[0].join(' | '), ...body.map(row => row.join(' | '))];
    doc.text(rows.join('\n'), 14, currentY);
    currentY += 20 + rows.length * 10;
  }
  doc.setFont(pdfFontName, 'normal');
  doc.setFontSize(12);
  doc.text(`${getTranslation('receipts_subtotal_label') || 'Subtotal'}: ${formatCurrency(data.subtotal)}`, 14, currentY);
  doc.text(`${getTranslation('receipts_tax_label') || 'Tax'}: ${formatCurrency(data.tax_total)}`, 14, currentY + 16);
  doc.setFontSize(14);
  doc.text(`${getTranslation('receipts_grand_label') || 'Grand Total'}: ${formatCurrency(data.grand_total)}`, 14, currentY + 36);
  doc.save(filename || `receipt-${Date.now()}.pdf`);
}

// ==============================
// Reports (Income vs Expense + charts)
// ==============================
let chartJob = null;
let chartCat = null;

async function runReport() {
  const start = document.getElementById('repStart').value;
  const end = document.getElementById('repEnd').value;
  const repJobs = document.getElementById('repJobs');
  const jobIds = Array.from(repJobs.selectedOptions).map(o => o.value).join(',');
  const lang = settings.language || 'en';

  const url = new URL(location.origin + '/api/report');
  if (start) url.searchParams.set('start', start);
  if (end) url.searchParams.set('end', end);
  if (jobIds) url.searchParams.set('job_ids', jobIds);

  const res = await fetch(url.toString(), { credentials: 'same-origin' });
  if (!ensureAuth(res)) return;
  if (!res.ok) {
    alert('Failed to run report');
    return;
  }
  const data = await res.json();

  const currencySymbol = getCurrencySymbol();
  setText('repIncome', `${currencySymbol}${Number(data.income_total).toLocaleString()}`);
  setText('repExpense', `${currencySymbol}${Number(data.expense_total).toLocaleString()}`);
  setText('repNet', `${currencySymbol}${Number(data.net).toLocaleString()}`);
  updatePeriodSnapshots(data.periods || {}, currencySymbol);

  // Charts
  const jobLabels = Object.keys(data.by_job || {});
  const jobValues = Object.values(data.by_job || {});
  const catLabels = Object.keys(data.by_category || {});
  const catValues = Object.values(data.by_category || {});

  const ctxJob = document.getElementById('chartByJob').getContext('2d');
  const ctxCat = document.getElementById('chartByCategory').getContext('2d');

  if (chartJob) chartJob.destroy();
  if (chartCat) chartCat.destroy();

  chartJob = new Chart(ctxJob, {
    type: 'bar',
    data: { labels: jobLabels, datasets: [{ label: getTranslation('chart_income', lang), data: jobValues, backgroundColor: '#60a5fa' }] },
    options: { responsive: true, plugins: { legend: {display: false} } }
  });

  chartCat = new Chart(ctxCat, {
    type: 'bar',
    data: { labels: catLabels, datasets: [{ label: getTranslation('chart_expense', lang), data: catValues, backgroundColor: '#f87171' }] },
    options: { responsive: true, plugins: { legend: {display: false} } }
  });
}

// ==============================
// Calculation (Preserved; now ties to selected job)
// ==============================
function calculateWage() {
  const date = document.getElementById('workDate').value;
  const startTime = document.getElementById('startTime').value;
  const endTime = document.getElementById('endTime').value;
  const breakStart = document.getElementById('breakStart').value;
  const breakEnd = document.getElementById('breakEnd').value;
  const shiftType = document.getElementById('shiftType').value;
  const hourlyWage = parseFloat(document.getElementById('hourlyWage').value);
  const currency = document.getElementById('currency').value;

  const jobSelect = document.getElementById('jobSelect');
  const jobId = jobSelect && jobSelect.value ? Number(jobSelect.value) : null;

  if (!date || !startTime || !endTime || !hourlyWage) {
    alert('Please fill in all required fields');
    return;
  }

  // Calculate work and breaks
  const startMinutes = timeToMinutes(startTime);
  const endMinutes = timeToMinutes(endTime);
  let totalMinutes = endMinutes - startMinutes;
  if (totalMinutes < 0) totalMinutes += 24 * 60;

  let breakMinutes = 0;
  if (breakStart && breakEnd) {
    const breakStartMinutes = timeToMinutes(breakStart);
    const breakEndMinutes = timeToMinutes(breakEnd);
    breakMinutes = breakEndMinutes - breakStartMinutes;
    if (breakMinutes < 0) breakMinutes += 24 * 60;
  }

  const netWorkMinutes = totalMinutes - breakMinutes;
  const netWorkHours = netWorkMinutes / 60;

  // Split night vs normal if enabled (your existing logic)
  let totalWage = 0;
  let totalNormalHours = 0;
  let totalNightHours = 0;

  if (advancedSettings.enableNightShift) {
    [totalNormalHours, totalNightHours] = splitNormalAndNightHours(
      startTime, endTime, breakStart, breakEnd,
      advancedSettings.nightStart, advancedSettings.nightEnd
    );
    totalWage = totalNormalHours * hourlyWage + totalNightHours * hourlyWage * 1.25;
  } else {
    totalNormalHours = netWorkHours;
    totalWage = netWorkHours * hourlyWage;
  }

  if (advancedSettings.enableOvertime && (totalNormalHours + totalNightHours) > advancedSettings.overtimeThreshold) {
    const overtimeHours = (totalNormalHours + totalNightHours) - advancedSettings.overtimeThreshold;
    const overtimeWage = overtimeHours * hourlyWage * (advancedSettings.overtimeRate / 100 - 1);
    totalWage += overtimeWage;
  }

  totalWage += parseFloat(advancedSettings.mealAllowance || 0);
  totalWage += parseFloat(advancedSettings.transportAllowance || 0);

  if (advancedSettings.weekendBonus > 0) {
    const workDate = new Date(date);
    const dayOfWeek = workDate.getDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      totalWage += totalWage * (advancedSettings.weekendBonus / 100);
    }
  }

  displayResults({
    date,
    startTime,
    endTime,
    breakStart,
    breakEnd,
    shiftType,
    totalHours: (netWorkMinutes / 60).toFixed(2),
    hourlyWage,
    currency,
    totalWage: Math.round(totalWage),
    jobId
  });

  if (settings.autoSave) {
    // Save to server
    saveShiftToServer({
      date,
      shift_type: shiftType,
      start_time: startTime,
      end_time: endTime,
      break_start: breakStart || '-',
      break_end: breakEnd || '-',
      total_hours: (netWorkMinutes / 60).toFixed(2),
      hourly_wage: hourlyWage,
      currency,
      total_wage: Math.round(totalWage),
      job_id: jobId
    });
  }
}

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function splitNormalAndNightHours(start, end, breakStart, breakEnd, nightStart, nightEnd) {
  // Returns [normalHours, nightHours]
  const dayMinutes = 24 * 60;
  const workStart = timeToMinutes(start);
  const rawEnd = timeToMinutes(end);
  const workEnd = rawEnd > workStart ? rawEnd : rawEnd + dayMinutes;
  let intervals = [[workStart, workEnd]];

  if (breakStart && breakEnd) {
    const bS0 = timeToMinutes(breakStart);
    const bE0 = timeToMinutes(breakEnd);
    const bS = (bS0 >= workStart) ? bS0 : bS0 + dayMinutes;
    const bE = (bE0 > bS) ? bE0 : bE0 + dayMinutes;

    let updated = [];
    intervals.forEach(([s, e]) => {
      if (bE <= s || bS >= e) updated.push([s, e]);
      else {
        if (bS > s) updated.push([s, bS]);
        if (bE < e) updated.push([bE, e]);
      }
    });
    intervals = updated;
  }

  const nS = timeToMinutes(nightStart); // e.g. 1320
  const nE = timeToMinutes(nightEnd);   // e.g. 300
  let normalMins = 0, nightMins = 0;

  intervals.forEach(([s, e]) => {
    // Night 1: 22:00~24:00
    let night1s = Math.max(s, nS), night1e = Math.min(e, dayMinutes);
    if (night1e > night1s) nightMins += night1e - night1s;

    // Night 2: 0:00~5:00 (if crossing midnight)
    let night2s = Math.max(s, 0), night2e = Math.min(e, nE);
    if (e > dayMinutes) {
      night2s = Math.max(s, dayMinutes);
      night2e = Math.min(e, dayMinutes + nE);
    }
    if (night2e > night2s) nightMins += night2e - night2s;

    const total = e - s;
    const nightPortion = Math.max(0, (night1e - night1s)) + Math.max(0, (night2e - night2s));
    normalMins += total - nightPortion;
  });

  return [normalMins / 60, nightMins / 60];
}

function displayResults(data) {
  const resultsDiv = document.getElementById('results');
  resultsDiv.innerHTML = `
    <div class="slide-in">
      <div class="bg-green-50 border border-green-200 rounded p-4 mb-4">
        <h3 class="text-lg font-semibold text-green-800 mb-2">💰 Calculation Results</h3>
        <div class="text-3xl font-bold text-green-600">${data.currency}${data.totalWage.toLocaleString()}</div>
        <div class="text-sm text-green-700 mt-1">Total wage for ${data.totalHours} hours</div>
      </div>
      <div class="space-y-1 text-sm">
        <div class="flex justify-between"><span class="text-gray-600">Date:</span><span class="font-medium">${data.date}</span></div>
        <div class="flex justify-between"><span class="text-gray-600">Shift Type:</span><span class="font-medium">${data.shiftType}</span></div>
        <div class="flex justify-between"><span class="text-gray-600">Work Time:</span><span class="font-medium">${data.startTime} - ${data.endTime}</span></div>
        ${data.breakStart && data.breakEnd ? `
        <div class="flex justify-between"><span class="text-gray-600">Break:</span><span class="font-medium">${data.breakStart} - ${data.breakEnd}</span></div>` : ''}
        <div class="flex justify-between"><span class="text-gray-600">Total Hours:</span><span class="font-medium">${data.totalHours}h</span></div>
        <div class="flex justify-between"><span class="text-gray-600">Hourly Rate:</span><span class="font-medium">${data.currency}${data.hourlyWage}</span></div>
      </div>
    </div>`;
}

async function saveShiftToServer(payload) {
  const res = await fetch('/api/shifts', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(payload)
  });
  if (!ensureAuth(res)) return;
  if (res.ok) {
    await loadShifts();
  } else {
    alert('Failed to save shift to server.');
  }
}

// ==============================
// Export
// ==============================
function exportToPDF() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  doc.setFontSize(20);
  doc.text('Wage Calculator - Shift History', 20, 20);
  let y = 40;
  doc.setFontSize(12);
  shiftHistory.forEach((s, i) => {
    if (y > 250) {
      doc.addPage();
      y = 20;
    }
    doc.text(`${i+1}. ${s.date} - ${s.job_name || ''} - ${s.shift_type || ''}`, 20, y);
    doc.text(`   ${s.start_time} to ${s.end_time} (${s.total_hours}h)`, 20, y+10);
    doc.text(`   Wage: ${s.currency}${Number(s.total_wage).toLocaleString()}`, 20, y+20);
    y += 35;
  });
  doc.save('wage-history.pdf');
}

function exportToCSV() {
  const headers = ['Date','Job','Type','Start','End','Break Start','Break End','Total Hours','Hourly Wage','Total Wage'];
  const csv = [
    headers.join(','),
    ...shiftHistory.map(s => [
      s.date, s.job_name || '', s.shift_type || '', s.start_time, s.end_time,
      s.break_start, s.break_end, s.total_hours, `${s.currency}${s.hourly_wage}`, `${s.currency}${s.total_wage}`
    ].join(','))
  ].join('\n');
  const blob = new Blob([csv], {type:'text/csv'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'wage-history.csv'; a.click();
  URL.revokeObjectURL(url);
}
