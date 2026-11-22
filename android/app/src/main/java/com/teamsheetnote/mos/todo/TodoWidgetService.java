package com.teamsheetnote.mos.todo;

import android.content.Context;
import android.content.Intent;
import android.text.SpannableString;
import android.text.Spanned;
import android.text.style.ForegroundColorSpan;
import android.text.style.StrikethroughSpan;
import android.view.View;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * 위젯의 스크롤 목록 줄을 만든다(2026-11-23 사용자 요청: 위젯 스크롤).
 * 내용은 TodoWidget이 받아 저장해 둔 오늘 TODO. 줄을 누르면 완료 켜고 끄기.
 */
public class TodoWidgetService extends RemoteViewsService {
    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new Rows(getApplicationContext());
    }

    static final class Rows implements RemoteViewsFactory {
        private final Context context;
        private List<JSONObject> items = new ArrayList<>();
        private Look look;

        Rows(Context context) {
            this.context = context;
        }

        @Override
        public void onCreate() {
            onDataSetChanged();
        }

        @Override
        public void onDataSetChanged() {
            look = Look.current(context);
            items = TodoWidget.savedItems(context);
        }

        @Override
        public void onDestroy() {
            items = new ArrayList<>();
        }

        @Override
        public int getCount() {
            return items.size();
        }

        @Override
        public RemoteViews getViewAt(int position) {
            RemoteViews row = new RemoteViews(context.getPackageName(), look.rowLayout());
            if (position < 0 || position >= items.size()) {
                return row;
            }
            JSONObject item = items.get(position);
            boolean isDone = item.optBoolean("done", false);
            boolean sheet = "sheet".equals(look.key);
            String time = item.isNull("time") ? "" : item.optString("time", "");
            String shownTime = look.timeKorean && !time.isEmpty() ? Look.koreanTime(time) : time;
            int categoryColor = TodoWidget.parseColorFor(item.optString("color", null), 0xFF8A8F98);
            SpannableString mark = new SpannableString(isDone ? look.markOn : look.markOff);
            mark.setSpan(new ForegroundColorSpan(look.markColor != 0 ? look.markColor : categoryColor),
                    0, mark.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            row.setTextViewText(R.id.row_mark, mark);
            // 한 줄로 'TODO | 시각 | 장소'. 스프레드시트만 시각을 C열에 따로 둔다(표 모양)
            String place = item.isNull("place") ? "" : item.optString("place", "");
            StringBuilder joined = new StringBuilder(item.optString("title", ""));
            if (!sheet && !shownTime.isEmpty()) {
                joined.append(" | ").append(shownTime);
            }
            if (!place.isEmpty()) {
                joined.append(" | ").append(place);
            }
            SpannableString text = new SpannableString(joined.toString());
            if (isDone) {
                text.setSpan(new StrikethroughSpan(), 0, text.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                text.setSpan(new ForegroundColorSpan(look.doneColor), 0, text.length(),
                        Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            }
            row.setTextViewText(R.id.row_text, text);
            row.setTextViewText(R.id.row_time, sheet ? shownTime : "");
            row.setViewVisibility(R.id.row_time, sheet ? View.VISIBLE : View.GONE);
            if (sheet) {
                row.setTextViewText(R.id.row_num, String.valueOf(position + 2));
            }
            Intent fill = new Intent()
                    .putExtra("id", item.optString("id"))
                    .putExtra("done", isDone);
            row.setOnClickFillInIntent(R.id.row, fill);
            return row;
        }

        @Override
        public RemoteViews getLoadingView() {
            return null;
        }

        @Override
        public int getViewTypeCount() {
            return 6;
        }

        @Override
        public long getItemId(int position) {
            return position;
        }

        @Override
        public boolean hasStableIds() {
            return false;
        }
    }
}
