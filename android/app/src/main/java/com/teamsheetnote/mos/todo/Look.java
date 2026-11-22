package com.teamsheetnote.mos.todo;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.Configuration;

/**
 * 위젯 모양(ㅁㅇㅅ 테마와 같은 6가지 + 휴대폰 다크 모드 따라가기).
 * 고른 값은 비밀이 아니라 일반 저장소에 둔다.
 */
final class Look {
    static final String AUTO = "auto";
    static final String[] KEYS = {AUTO, "moon", "night", "sheet", "memo", "note", "word"};
    static final String[] NAMES = {
            "휴대폰 설정 따라(기본, 다크)", "기본", "다크", "스프레드시트", "메모장", "노션", "Word",
    };

    final String key;
    final int layout;
    final String markOff;
    final String markOn;
    /** 표시 색: 0이면 카테고리 색 */
    final int markColor;
    final int doneColor;
    /** 시각을 이름 앞에 붙임(HH:MM) */
    final boolean timeInline;
    /** 예전 12시간 표시 자리(지금은 HH:MM 그대로) */
    final boolean timeKorean;
    final String dateStyle;

    private Look(String key, int layout, String markOff, String markOn, int markColor, int doneColor,
                 boolean timeInline, boolean timeKorean, String dateStyle) {
        this.key = key;
        this.layout = layout;
        this.markOff = markOff;
        this.markOn = markOn;
        this.markColor = markColor;
        this.doneColor = doneColor;
        this.timeInline = timeInline;
        this.timeKorean = timeKorean;
        this.dateStyle = dateStyle;
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences("mos_todo_look", Context.MODE_PRIVATE);
    }

    static String chosen(Context context) {
        String value = prefs(context).getString("look", AUTO);
        for (String key : KEYS) {
            if (key.equals(value)) {
                return key;
            }
        }
        return AUTO;
    }

    static void choose(Context context, String key) {
        prefs(context).edit().putString("look", key).apply();
    }

    /** 위젯 목록 한 줄 모양 */
    int rowLayout() {
        switch (key) {
            case "night":
                return R.layout.widget_row_night;
            case "sheet":
                return R.layout.widget_row_sheet;
            case "memo":
                return R.layout.widget_row_memo;
            case "note":
                return R.layout.widget_row_note;
            case "word":
                return R.layout.widget_row_word;
            default:
                return R.layout.widget_row_moon;
        }
    }

    static Look current(Context context) {
        String key = chosen(context);
        if (AUTO.equals(key)) {
            int mode = context.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
            key = mode == Configuration.UI_MODE_NIGHT_YES ? "night" : "moon";
        }
        switch (key) {
            case "night":
                return new Look(key, R.layout.widget_night, "○", "●", 0, 0xFFA7A08F, false, true, "long");
            case "sheet":
                return new Look(key, R.layout.widget_sheet, "☐", "☑", 0xFF1F6E43, 0xFF8A8F98, false, false, "sheet");
            case "memo":
                return new Look(key, R.layout.widget_memo, "[ ]", "[✓]", 0xFF111111, 0xFF8A8F98, true, false, "memo");
            case "note":
                return new Look(key, R.layout.widget_note, "☐", "☑", 0xFF2383E2, 0xFF9B9A97, false, true, "long");
            case "word":
                return new Look(key, R.layout.widget_word, "☐", "☑", 0xFF185ABD, 0xFF8A8F98, true, true, "long");
            default:
                return new Look("moon", R.layout.widget_moon, "○", "●", 0, 0xFF8A8F98, false, true, "long");
        }
    }

    /** 시각은 어디서나 24시간 HH:MM */
    static String koreanTime(String time) {
        return time.length() >= 5 ? time.substring(0, 5) : time;
    }
}
