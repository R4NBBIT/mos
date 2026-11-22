package com.teamsheetnote.mos.todo;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.text.SpannableString;
import android.text.Spanned;
import android.text.style.ForegroundColorSpan;
import android.text.style.StrikethroughSpan;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.time.LocalDate;
import java.time.format.TextStyle;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;

/**
 * 홈 화면 위젯: 오늘 할 일(최대 8줄). 줄을 누르면 완료 켜고 끄기, ↻는 새로 고침, 날짜는 ㅁㅇㅅ 열기.
 * 모양은 앱에서 고른 테마(Look: 기본, 다크, 스프레드시트, 메모장, 노션, Word)
 */
public class TodoWidget extends AppWidgetProvider {
    static final String TOGGLE = "com.teamsheetnote.mos.todo.TOGGLE";
    static final String REFRESH = "com.teamsheetnote.mos.todo.REFRESH";
    private static final int[] ROWS = {
            R.id.row0, R.id.row1, R.id.row2, R.id.row3, R.id.row4, R.id.row5, R.id.row6, R.id.row7,
    };
    private static final int[] MARKS = {
            R.id.row0_mark, R.id.row1_mark, R.id.row2_mark, R.id.row3_mark,
            R.id.row4_mark, R.id.row5_mark, R.id.row6_mark, R.id.row7_mark,
    };
    private static final int[] TEXTS = {
            R.id.row0_text, R.id.row1_text, R.id.row2_text, R.id.row3_text,
            R.id.row4_text, R.id.row5_text, R.id.row6_text, R.id.row7_text,
    };
    private static final int[] TIMES = {
            R.id.row0_time, R.id.row1_time, R.id.row2_time, R.id.row3_time,
            R.id.row4_time, R.id.row5_time, R.id.row6_time, R.id.row7_time,
    };

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        refreshAsync(context);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        String action = intent.getAction();
        if (REFRESH.equals(action)) {
            refreshAsync(context);
        } else if (TOGGLE.equals(action)) {
            String id = intent.getStringExtra("id");
            boolean done = intent.getBooleanExtra("done", false);
            PendingResult pending = goAsync();
            new Thread(() -> {
                try {
                    Api.tool(context, "complete_todo", new JSONObject().put("id", id).put("done", !done));
                    draw(context);
                } catch (Exception error) {
                    show(context, null, error instanceof Api.AuthLost ? "앱을 열어 다시 로그인해 주세요." : "바꾸지 못했어요.");
                } finally {
                    pending.finish();
                }
            }).start();
        }
    }

    static void refreshAsync(Context context) {
        new Thread(() -> draw(context)).start();
    }

    static void refreshAll(Context context) {
        refreshAsync(context);
    }

    private static void draw(Context context) {
        if (!Store.signedIn(context)) {
            show(context, null, "앱을 열어 로그인해 주세요.");
            return;
        }
        try {
            String today = LocalDate.now().toString();
            JSONObject data = Api.tool(context, "list_todos", new JSONObject().put("start_day", today));
            show(context, data.getJSONArray("todos"), null);
        } catch (Api.AuthLost lost) {
            show(context, null, "앱을 열어 다시 로그인해 주세요.");
        } catch (Exception error) {
            show(context, null, "불러오지 못했어요. ↻를 눌러 다시.");
        }
    }

    private static PendingIntent broadcast(Context context, int code, Intent intent) {
        intent.setClass(context, TodoWidget.class);
        return PendingIntent.getBroadcast(context, code, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static int parseColor(String value, int fallback) {
        if (value == null || !value.matches("#[0-9a-fA-F]{6}")) {
            return fallback;
        }
        return 0xFF000000 | Integer.parseInt(value.substring(1), 16);
    }

    private static String dateText(Look look, LocalDate now) {
        String weekday = now.getDayOfWeek().getDisplayName(TextStyle.SHORT, Locale.KOREAN);
        String base = now.getMonthValue() + "월 " + now.getDayOfMonth() + "일";
        switch (look.dateStyle) {
            case "sheet":
                return base + " 할 일";
            case "memo":
                return "== " + base + " (" + weekday + ") ==";
            default:
                return base + " " + now.getDayOfWeek().getDisplayName(TextStyle.FULL, Locale.KOREAN);
        }
    }

    private static void show(Context context, JSONArray todos, String message) {
        Look look = Look.current(context);
        RemoteViews views = new RemoteViews(context.getPackageName(), look.layout);
        LocalDate now = LocalDate.now();
        views.setTextViewText(R.id.title, dateText(look, now));
        views.setOnClickPendingIntent(R.id.refresh, broadcast(context, 1, new Intent(REFRESH)));
        Intent open = new Intent(Intent.ACTION_VIEW, Uri.parse(Api.ORIGIN + "/#/todo"));
        views.setOnClickPendingIntent(R.id.head,
                PendingIntent.getActivity(context, 2, open, PendingIntent.FLAG_IMMUTABLE));
        if (message != null) {
            views.setViewVisibility(R.id.message, View.VISIBLE);
            views.setTextViewText(R.id.message, message);
            views.setTextViewText(R.id.count, "");
        } else {
            views.setViewVisibility(R.id.message, View.GONE);
        }
        // 안 한 것 먼저, 시각 순(PC 위젯과 같게)
        List<JSONObject> items = new ArrayList<>();
        if (todos != null) {
            for (int index = 0; index < todos.length(); index++) {
                JSONObject item = todos.optJSONObject(index);
                if (item != null) {
                    items.add(item);
                }
            }
        }
        items.sort(Comparator
                .comparing((JSONObject item) -> item.optBoolean("done", false))
                .thenComparing(item -> item.isNull("time") ? "99" : item.optString("time", "99")));
        int total = items.size();
        int done = 0;
        for (JSONObject item : items) {
            if (item.optBoolean("done", false)) {
                done++;
            }
        }
        for (int index = 0; index < ROWS.length; index++) {
            if (index >= total) {
                views.setViewVisibility(ROWS[index], View.GONE);
                continue;
            }
            JSONObject item = items.get(index);
            boolean isDone = item.optBoolean("done", false);
            String time = item.isNull("time") ? "" : item.optString("time", "");
            String shownTime = look.timeKorean && !time.isEmpty() ? Look.koreanTime(time) : time;
            views.setViewVisibility(ROWS[index], View.VISIBLE);
            if (index == ROWS.length - 1 && total > ROWS.length) {
                views.setTextViewText(MARKS[index], "");
                views.setTextViewText(TEXTS[index], "외 " + (total - ROWS.length + 1) + "개 더(날짜를 눌러 보기)");
                views.setTextViewText(TIMES[index], "");
                views.setOnClickPendingIntent(ROWS[index],
                        PendingIntent.getActivity(context, 3, open, PendingIntent.FLAG_IMMUTABLE));
                continue;
            }
            int categoryColor = parseColor(item.optString("color", null), 0xFF8A8F98);
            SpannableString mark = new SpannableString(isDone ? look.markOn : look.markOff);
            mark.setSpan(new ForegroundColorSpan(look.markColor != 0 ? look.markColor : categoryColor),
                    0, mark.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            views.setTextViewText(MARKS[index], mark);
            String title = item.optString("title", "");
            String line = look.timeInline && !shownTime.isEmpty() ? shownTime + " " + title : title;
            SpannableString text = new SpannableString(line);
            if (isDone) {
                text.setSpan(new StrikethroughSpan(), 0, text.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                text.setSpan(new ForegroundColorSpan(look.doneColor), 0, text.length(),
                        Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            }
            views.setTextViewText(TEXTS[index], text);
            views.setTextViewText(TIMES[index], look.timeInline ? "" : shownTime);
            views.setViewVisibility(TIMES[index], look.timeInline ? View.GONE : View.VISIBLE);
            Intent toggle = new Intent(TOGGLE)
                    .putExtra("id", item.optString("id"))
                    .putExtra("done", isDone);
            views.setOnClickPendingIntent(ROWS[index], broadcast(context, 100 + index, toggle));
        }
        if (todos != null) {
            String count = done + "/" + total;
            if ("memo".equals(look.key)) {
                count = "(" + count + ")";
            } else if ("word".equals(look.key)) {
                count = count + " 완료";
            }
            views.setTextViewText(R.id.count, count);
            if (look.key.equals("moon") || look.key.equals("night")) {
                views.setProgressBar(R.id.progress, 100, total == 0 ? 0 : done * 100 / total, false);
            }
            if (total == 0) {
                views.setViewVisibility(R.id.message, View.VISIBLE);
                views.setTextViewText(R.id.message, "오늘 할 일이 없어요.");
            }
        }
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] widgetIds = manager.getAppWidgetIds(new ComponentName(context, TodoWidget.class));
        manager.updateAppWidget(widgetIds, views);
    }
}
