# F1-50 DRAFT report (NOT verified gold)

> Heuristic draft. `note`=""; stratum is a guess (`stratumConfidence: "guess"`); flags are heuristic.
> Cumulative-touching items are in `_cumulative-candidates.jsonl`, NOT the main draft. Verify by hand.

- formula_1 records processed: **66**
- non-cumulative draft items (`_f1-draft.jsonl`): **64**
- cumulative candidates (`_cumulative-candidates.jsonl`): **2**

## Guessed stratum counts (non-cumulative draft)

| stratum | count |
|---|---|
| declared-join | 27 |
| enum-filter | 26 |
| single-table | 11 |

## FLAGS (top: CUMULATIVE_SUM, TEXT_ORDER)

### TEXT_ORDER (4)

| id | question | detail |
|---|---|---|
| f1-bird-846 | Please list the reference names of the drivers who are eliminated i… | ORDER BY qualifying.q1 (text, time/numeric-looking) — lexical vs temporal sort risk |
| f1-bird-847 | What is the surname of the driver with the best lap time in race nu… | ORDER BY qualifying.q2 (text, time/numeric-looking) — lexical vs temporal sort risk |
| f1-bird-879 | For the driver who set the fastest lap speed, what is his nationality? | ORDER BY results.fastestlapspeed (text, time/numeric-looking) — lexical vs temporal sort risk |
| f1-bird-931 | What was the fastest lap speed among all drivers in the 2009 Spanis… | ORDER BY results.fastestlapspeed (text, time/numeric-looking) — lexical vs temporal sort risk |

### NULL_ORDER (16)

| id | question | detail |
|---|---|---|
| f1-bird-846 | Please list the reference names of the drivers who are eliminated i… | explicit NULLS FIRST/LAST — verify NULL placement vs intended selection |
| f1-bird-847 | What is the surname of the driver with the best lap time in race nu… | explicit NULLS FIRST/LAST — verify NULL placement vs intended selection |
| f1-bird-865 | For all the drivers who finished the game in race No. 592, who is t… | explicit NULLS FIRST/LAST — verify NULL placement vs intended selection |
| f1-bird-869 | For the constructor which got the highest point in the race No. 9 ,… | explicit NULLS FIRST/LAST — verify NULL placement vs intended selection |
| f1-bird-877 | For all the drivers who finished the game in race No. 872, who is t… | explicit NULLS FIRST/LAST — verify NULL placement vs intended selection |
| f1-bird-879 | For the driver who set the fastest lap speed, what is his nationality? | explicit NULLS FIRST/LAST — verify NULL placement vs intended selection |
| f1-bird-884 | List the names of all races that occurred in the earliest recorded … | explicit NULLS FIRST/LAST — verify NULL placement vs intended selection |
| f1-bird-892 | State the driver with the most points scored. Find his full name wi… | explicit NULLS FIRST/LAST — verify NULL placement vs intended selection |
| f1-bird-894 | What is the best lap time recorded? List the driver and race with s… | explicit NULLS FIRST/LAST — verify NULL placement vs intended selection |
| f1-bird-897 | Name the driver with the most winning. Mention his nationality and … | explicit NULLS FIRST/LAST — verify NULL placement vs intended selection |
| f1-bird-904 | State the race and year of race in which Michael Schumacher had his… | explicit NULLS FIRST/LAST — verify NULL placement vs intended selection |
| f1-bird-906 | Which was Lewis Hamilton first race? What was his points recorded f… | explicit NULLS FIRST/LAST — verify NULL placement vs intended selection |
| f1-bird-915 | Which country is the oldest driver from? | explicit NULLS FIRST/LAST — verify NULL placement vs intended selection |
| f1-bird-931 | What was the fastest lap speed among all drivers in the 2009 Spanis… | explicit NULLS FIRST/LAST — verify NULL placement vs intended selection |
| f1-bird-981 | On what year did the youngest driver had his first qualifying race?… | explicit NULLS FIRST/LAST — verify NULL placement vs intended selection |
| f1-bird-1003 | How many accidents did the driver who had the highest number accide… | explicit NULLS FIRST/LAST — verify NULL placement vs intended selection |

### FANOUT (1)

| id | question | detail |
|---|---|---|
| f1-bird-972 | Which drivers who were born in 1971 and has the fastest lap time on… | joinCount=1, rowCount=150, no GROUP BY/DISTINCT — possible join fan-out |

### LITERAL_UNVERIFIED (54)

| id | question | detail |
|---|---|---|
| f1-bird-850 | Please give the name of the race held on the circuits in Germany. | circuits.country = 'Germany' → inSampleValues=true |
| f1-bird-854 | What is the coordinates location of the circuits for Australian gra… | races.name = 'Australian Grand Prix' → inSampleValues=true |
| f1-bird-857 | Give the coordinate position for Abu Dhabi Grand Prix. | races.name = 'Abu Dhabi Grand Prix' → inSampleValues=true |
| f1-bird-859 | What's Bruno Senna's Q1 result in the qualifying race No. 354? | drivers.forename = 'Bruno' → inSampleValues=unknown(no sampleValues) |
| f1-bird-859 | What's Bruno Senna's Q1 result in the qualifying race No. 354? | drivers.surname = 'Senna' → inSampleValues=unknown(no sampleValues) |
| f1-bird-862 | For the Bahrain Grand Prix in 2007, how many drivers not finished t… | races.name = 'Bahrain Grand Prix' → inSampleValues=true |
| f1-bird-868 | Where is Malaysian Grand Prix held? Give the location coordinates. | races.name = 'Malaysian Grand Prix' → inSampleValues=true |
| f1-bird-880 | Paul di Resta was in the No. 853 race, what percent faster did he f… | drivers.forename = 'Paul' → inSampleValues=unknown(no sampleValues) |
| f1-bird-880 | Paul di Resta was in the No. 853 race, what percent faster did he f… | drivers.surname = 'di Resta' → inSampleValues=unknown(no sampleValues) |
| f1-bird-881 | For the drivers who took part in the race in 1983/7/16, what's thei… | races.date = '1983-07-16' → inSampleValues=unknown(no sampleValues) |
| f1-bird-895 | What is the average lap time for Lewis Hamilton in the 2009 Malaysi… | drivers.forename = 'Lewis' → inSampleValues=unknown(no sampleValues) |
| f1-bird-895 | What is the average lap time for Lewis Hamilton in the 2009 Malaysi… | drivers.surname = 'Hamilton' → inSampleValues=unknown(no sampleValues) |
| f1-bird-895 | What is the average lap time for Lewis Hamilton in the 2009 Malaysi… | races.name = 'Malaysian Grand Prix' → inSampleValues=true |
| f1-bird-896 | Calculate the percentage whereby Hamilton was not at the 1st track … | drivers.surname = 'Hamilton' → inSampleValues=unknown(no sampleValues) |
| f1-bird-898 | How old is the youngest Japanese driver? What is his name? | drivers.nationality = 'Japanese' → inSampleValues=true |
| f1-bird-902 | Which race was Alex Yoong in when he was in track number less than 20? | drivers.forename = 'Alex' → inSampleValues=unknown(no sampleValues) |
| f1-bird-902 | Which race was Alex Yoong in when he was in track number less than 20? | drivers.surname = 'Yoong' → inSampleValues=unknown(no sampleValues) |
| f1-bird-904 | State the race and year of race in which Michael Schumacher had his… | drivers.forename = 'Michael' → inSampleValues=unknown(no sampleValues) |
| f1-bird-904 | State the race and year of race in which Michael Schumacher had his… | drivers.surname = 'Schumacher' → inSampleValues=unknown(no sampleValues) |
| f1-bird-906 | Which was Lewis Hamilton first race? What was his points recorded f… | drivers.forename = 'Lewis' → inSampleValues=unknown(no sampleValues) |
| f1-bird-906 | Which was Lewis Hamilton first race? What was his points recorded f… | drivers.surname = 'Hamilton' → inSampleValues=unknown(no sampleValues) |
| f1-bird-909 | Among all European Grand Prix races, what is the percentage of the … | races.name = 'European Grand Prix' → inSampleValues=true |
| f1-bird-910 | What's the location coordinates of Silverstone Circuit? | circuits.name = 'Silverstone Circuit' → inSampleValues=unknown(no sampleValues) |
| f1-bird-912 | What's the reference name of Marina Bay Street Circuit? | circuits.name = 'Marina Bay Street Circuit' → inSampleValues=unknown(no sampleValues) |
| f1-bird-928 | Which driver ranked the first in the Canadian Grand Prix in 2007? P… | races.name = 'Canadian Grand Prix' → inSampleValues=true |
| f1-bird-930 | In which Formula_1 race did Lewis Hamilton rank the highest? | raceid = 'Lewis' → inSampleValues=unknown(no sampleValues) |
| f1-bird-930 | In which Formula_1 race did Lewis Hamilton rank the highest? | raceid = 'Hamilton' → inSampleValues=unknown(no sampleValues) |
| f1-bird-930 | In which Formula_1 race did Lewis Hamilton rank the highest? | driverid = 'Lewis' → inSampleValues=unknown(no sampleValues) |
| f1-bird-930 | In which Formula_1 race did Lewis Hamilton rank the highest? | driverid = 'Hamilton' → inSampleValues=unknown(no sampleValues) |
| f1-bird-930 | In which Formula_1 race did Lewis Hamilton rank the highest? | drivers.forename = 'Lewis' → inSampleValues=unknown(no sampleValues) |
| f1-bird-930 | In which Formula_1 race did Lewis Hamilton rank the highest? | drivers.surname = 'Hamilton' → inSampleValues=unknown(no sampleValues) |
| f1-bird-931 | What was the fastest lap speed among all drivers in the 2009 Spanis… | races.name = 'Spanish Grand Prix' → inSampleValues=true |
| f1-bird-933 | What was Lewis Hamilton's final rank in the 2008 Chinese Grand Prix? | drivers.forename = 'Lewis' → inSampleValues=unknown(no sampleValues) |
| f1-bird-933 | What was Lewis Hamilton's final rank in the 2008 Chinese Grand Prix? | drivers.surname = 'Hamilton' → inSampleValues=unknown(no sampleValues) |
| f1-bird-933 | What was Lewis Hamilton's final rank in the 2008 Chinese Grand Prix? | races.name = 'Chinese Grand Prix' → inSampleValues=true |
| f1-bird-937 | What's the finish time for the driver who ranked second in 2008's C… | races.name = 'Chinese Grand Prix' → inSampleValues=true |
| f1-bird-945 | How many circuits are there in Adelaide, Australia? | circuits.location = 'Adelaide' → inSampleValues=unknown(no sampleValues) |
| f1-bird-945 | How many circuits are there in Adelaide, Australia? | circuits.country = 'Australia' → inSampleValues=true |
| f1-bird-948 | What are the maximum points of British constructors? | constructors.nationality = 'British' → inSampleValues=true |
| f1-bird-951 | How many Japanese constructors have 0 points in 2 races? | constructors.nationality = 'Japanese' → inSampleValues=true |
| f1-bird-954 | Please calculate the race completion percentage of Japanese drivers… | drivers.nationality = 'Japanese' → inSampleValues=true |
| f1-bird-960 | What is the average of fastest lap speed in the 2009 Spanish Grand … | races.name = 'Spanish Grand Prix' → inSampleValues=true |
| f1-bird-963 | How many French drivers who obtain the laptime less than 02:00.00? | drivers.nationality = 'French' → inSampleValues=true |
| f1-bird-964 | List out the code for drivers who have nationality in America. | drivers.nationality = 'American' → inSampleValues=true |
| f1-bird-967 | State code numbers of top 3 yougest drivers. How many Netherlandic … | drivers.nationality = 'Dutch' → inSampleValues=true |
| f1-bird-971 | Please state the reference name of the oldest German driver. | drivers.nationality = 'German' → inSampleValues=true |
| f1-bird-978 | How many times the circuits were held in Austria? Please give their… | circuits.country = 'Austria' → inSampleValues=true |
| f1-bird-988 | List down top 3 German drivers who has the shortest average pit sto… | drivers.nationality = 'German' → inSampleValues=true |
| f1-bird-989 | Who is the champion of the Canadian Grand Prix in 2008? Indicate hi… | races.name = 'Canadian Grand Prix' → inSampleValues=true |
| f1-bird-990 | What is the constructor reference name of the champion in the 2009 … | races.name = 'Singapore Grand Prix' → inSampleValues=true |
| f1-bird-994 | Which constructor scored most points from Monaco Grand Prix between… | races.name = 'Monaco Grand Prix' → inSampleValues=true |
| f1-bird-1001 | What is full name of the racer who ranked 1st in the 3rd qualifying… | races.circuitid = 'Marina Bay Street Circuit' → inSampleValues=unknown(no sampleValues) |
| f1-bird-1001 | What is full name of the racer who ranked 1st in the 3rd qualifying… | name = 'Marina Bay Street Circuit' → inSampleValues=unknown(no sampleValues) |
| f1-bird-1003 | How many accidents did the driver who had the highest number accide… | races.name = 'Canadian Grand Prix' → inSampleValues=true |
