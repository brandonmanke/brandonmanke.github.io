/**
 * Idea: make each gradient appear one at a time 
 * or maybe make top then bottom ones appear etc.
 *
 * Another really interesting but hard idea:
 * Somehow simulate a shooting star in the background
 * that would ocassionally appear in different areas of the screen.
 * I believe I would need to use canvas to implement something like this.
 *
 * TODO:
 * Add noscript tags
 * Also try to add as much support for older browsers
 * (Check out mondernizr)
 * Noticed a weird bug with the skewed gradients on safari
 */
;(function() {
    window.onload = function() {
        setTimeout(function() {
            document.querySelector('.background').className += ' show'
        }, 500)
        setTimeout(function() {
            document.querySelector('.title').className += ' show'
        }, 1000)
        setTimeout(function() {
            document.querySelector('.about').className += ' show'
            document.querySelector('.projects').className += ' show'
        }, 1000)
    }
})(this)